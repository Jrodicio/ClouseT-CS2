import { setGlobalOptions } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import * as admin from 'firebase-admin';
import { defineSecret } from 'firebase-functions/params';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
// import * as crypto from 'crypto';

setGlobalOptions({ maxInstances: 15, region: 'us-central1' });

admin.initializeApp();

// ====== Secrets ======
const STEAM_API_KEY = defineSecret('STEAM_API_KEY');

// Pterodactyl (Client API)
const PTERO_CLIENT_KEY = defineSecret('PTERO_CLIENT_KEY');
const PTERO_SERVER_ID = defineSecret('PTERO_SERVER_ID');
const PTERO_PANEL_ORIGIN = defineSecret('PTERO_PANEL_ORIGIN');
const GAME_SERVER_HOST = defineSecret('GAME_SERVER_HOST');
const GAME_SERVER_PORT = defineSecret('GAME_SERVER_PORT');
const GAME_SERVER_SPECTATE_PORT = defineSecret('GAME_SERVER_SPECTATE_PORT');
const PUBLIC_BASE_URL = defineSecret('PUBLIC_BASE_URL');

// ====== Steam OpenID ======
const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';

// Helper: arma base URL (funciona en prod detrás de Hosting)
function getBaseUrl(req: any) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

function isDevHost(host: string | undefined): boolean {
  if (process.env.FUNCTIONS_EMULATOR || process.env.FIREBASE_EMULATOR_HUB) {
    return true;
  }

  const hostname = (host ?? '').split(':')[0];
  if (!hostname) return false;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.dev');
}

function getPublicBaseUrl(): string {
  const explicitBaseUrl = PUBLIC_BASE_URL.value();
  if (explicitBaseUrl) {
    return explicitBaseUrl.replace(/\/+$/, '');
  }

  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  if (!projectId) {
    throw new Error('Missing PUBLIC_BASE_URL secret or project id');
  }

  return `https://${projectId}.web.app`;
}

// Helper: extrae steamId desde claimed_id
function extractSteamId(claimedId: string | undefined | null): string | null {
  if (!claimedId) return null;
  const m = claimedId.match(/https?:\/\/steamcommunity\.com\/openid\/id\/(\d+)/);
  return m?.[1] ?? null;
}

// ====== Match constants ======
const MATCH_DOC_PATH = 'matches/current';
const TEAM1_NAME = 'Team A';
const TEAM2_NAME = 'Team B';
const DEFAULT_MAP_POOL = [
  'de_inferno',
  'de_mirage',
  'de_nuke',
  'de_overpass',
  'de_ancient',
  'de_vertigo',
  'de_anubis',
] as const;

type MatchJson = {
  num_maps: number;
  maplist: string[];
  team1: { name: string; players: Record<string, string> };
  team2: { name: string; players: Record<string, string> };
};

type MatchJsonResult =
  | { ok: true; match: MatchJson }
  | { ok: false; reason: 'NOT_FOUND' | 'NOT_READY'; error: string };

type ServerConnectionInfo =
  | {
      ok: true;
      host: string;
      port: number;
      spectatePort: number;
      connectUrl: string;
      spectateUrl: string;
    }
  | { ok: false; error: string };

function getServerConnectionInfo(): ServerConnectionInfo {
  const host = GAME_SERVER_HOST.value();
  const portRaw = GAME_SERVER_PORT.value();
  const spectatePortRaw = GAME_SERVER_SPECTATE_PORT.value() || portRaw;

  if (!host || !portRaw) {
    return { ok: false, error: 'Missing GAME_SERVER_HOST or GAME_SERVER_PORT secret' };
  }

  const port = Number(portRaw);
  const spectatePort = Number(spectatePortRaw);

  if (!Number.isFinite(port) || port <= 0 || !Number.isFinite(spectatePort) || spectatePort <= 0) {
    return { ok: false, error: 'Invalid GAME_SERVER_PORT or GAME_SERVER_SPECTATE_PORT secret' };
  }

  return {
    ok: true,
    host,
    port,
    spectatePort,
    connectUrl: `steam://connect/${host}:${port}`,
    spectateUrl: `steam://connect/${host}:${spectatePort}`,
  };
}

function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>(
    (acc, [key, val]) => {
      if (typeof key === 'string' && typeof val === 'string') {
        acc[key] = val;
      }
      return acc;
    },
    {}
  );
}

function normalizePlayers(
  players: unknown,
  playerNames?: unknown
): { ids: string[]; names: Record<string, string> } {
  if (Array.isArray(players)) {
    const ids = players.filter((id): id is string => typeof id === 'string');
    if (ids.length > 0) {
      const nameOverrides = toStringRecord(playerNames);
      const names = ids.reduce<Record<string, string>>((acc, id) => {
        acc[id] = nameOverrides[id] ?? id;
        return acc;
      }, {});
      return { ids, names };
    }

    const namesFromArray = players.reduce<Record<string, string>>((acc, entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return acc;
      for (const [key, val] of Object.entries(entry as Record<string, unknown>)) {
        if (typeof key === 'string' && typeof val === 'string') {
          acc[key] = val;
        }
      }
      return acc;
    }, {});

    const idsFromArray = Object.keys(namesFromArray);
    return { ids: idsFromArray, names: namesFromArray };
  }

  const namesFromObject = toStringRecord(players);
  const ids = Object.keys(namesFromObject);
  return { ids, names: namesFromObject };
}

async function getSteamProfileNames(
  ids: string[]
): Promise<{ names: Record<string, string>; missing: string[] }> {
  const db = admin.firestore();
  if (ids.length === 0) return { names: {}, missing: [] };

  const refs = ids.map((id) => db.collection('steamProfiles').doc(id));
  const snaps = await db.getAll(...refs);

  const names: Record<string, string> = {};
  const missing: string[] = [];

  snaps.forEach((snap, idx) => {
    const id = ids[idx];
    if (!snap.exists) {
      missing.push(id);
      return;
    }
    const data = snap.data() as { personaName?: unknown } | undefined;
    const personaName = typeof data?.personaName === 'string' ? data.personaName.trim() : '';
    if (!personaName) {
      missing.push(id);
      return;
    }
    names[id] = personaName;
  });

  return { names, missing };
}

async function buildMatchJson(
  map: unknown,
  team1: { name?: unknown; players?: unknown },
  team2: { name?: unknown; players?: unknown }
): Promise<MatchJsonResult> {
  if (!map || typeof map !== 'string') {
    return { ok: false, reason: 'NOT_READY', error: 'Missing map' };
  }

  const team1Normalized = normalizePlayers(team1?.players, (team1 as any)?.playerNames);
  const team2Normalized = normalizePlayers(team2?.players, (team2 as any)?.playerNames);
  const team1Players = team1Normalized.ids;
  const team2Players = team2Normalized.ids;

  if (team1Players.length !== 5 || team2Players.length !== 5) {
    return { ok: false, reason: 'NOT_READY', error: 'Teams must have 5 players each' };
  }

  const ids = [...new Set([...team1Players, ...team2Players])];
  const profiles = await getSteamProfileNames(ids);
  if (profiles.missing.length > 0) {
    return {
      ok: false,
      reason: 'NOT_READY',
      error: `Missing steamProfiles for: ${profiles.missing.join(', ')}`,
    };
  }

  const team1Names = team1Players.reduce<Record<string, string>>((acc, id) => {
    acc[id] = profiles.names[id];
    return acc;
  }, {});
  const team2Names = team2Players.reduce<Record<string, string>>((acc, id) => {
    acc[id] = profiles.names[id];
    return acc;
  }, {});

  console.log("jsonMatch:",{
    ok: true,
    match: {
      num_maps: 1,
      maplist: [map],
      team1: {
        name: typeof team1?.name === 'string' ? team1.name : TEAM1_NAME,
        players: team1Names,
      },
      team2: {
        name: typeof team2?.name === 'string' ? team2.name : TEAM2_NAME,
        players: team2Names,
      },
    },
  })

  return {
    ok: true,
    match: {
      num_maps: 1,
      maplist: [map],
      team1: {
        name: typeof team1?.name === 'string' ? team1.name : TEAM1_NAME,
        players: team1Names,
      },
      team2: {
        name: typeof team2?.name === 'string' ? team2.name : TEAM2_NAME,
        players: team2Names,
      },
    },
  };
}

function initialMatchDoc() {
  return {
    estado: 'esperando_jugadores',
    map: null,
    team1: { name: TEAM1_NAME, players: [] },
    team2: { name: TEAM2_NAME, players: [] },
    queue: [],
    mapPool: [...DEFAULT_MAP_POOL],
    bannedMaps: [],
    mapTurn: 'team1',
    mapBanCount: 0,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

async function getCurrentMatchJson(): Promise<MatchJsonResult> {
  const db = admin.firestore();
  const ref = db.doc(MATCH_DOC_PATH);
  const snap = await ref.get();

  if (!snap.exists) {
    return { ok: false, reason: 'NOT_FOUND', error: 'Match not found' };
  }

  const cur = snap.data() as any;
  return buildMatchJson(cur?.map, cur?.team1 ?? {}, cur?.team2 ?? {});
}

// ====== Util: ejecutar comando en Pterodactyl (Client API) ======
class PterodactylCommandError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(`Pterodactyl command failed: HTTP ${status} ${body}`.trim());
    this.status = status;
    this.body = body;
  }
}

async function pteroSendCommand(command: string): Promise<void> {
  const panelOrigin = PTERO_PANEL_ORIGIN.value(); // ej https://pterodactyl.histeriaservers.com.ar
  const serverId = PTERO_SERVER_ID.value(); // ej ba39664e
  const apiKey = PTERO_CLIENT_KEY.value(); // ptlc_...

  if (!panelOrigin || !serverId || !apiKey) {
    throw new Error(
      'Missing Pterodactyl secrets (PTERO_PANEL_ORIGIN / PTERO_SERVER_ID / PTERO_CLIENT_KEY)'
    );
  }

  const url = `${panelOrigin.replace(/\/+$/, '')}/api/client/servers/${encodeURIComponent(
    serverId
  )}/command`;

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ command }),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new PterodactylCommandError(r.status, t);
  }
}

// =====================================================
// Start match (shared) — NUEVO ✅
//  - lock (startInProgress)
//  - usa /api/match/config para el JSON del match
//  - ejecuta matchzy_loadmatch_url
//  - actualiza estado a en_curso
// =====================================================
type StartMatchResult =
  | { ok: true; command: string; matchConfigUrl: string }
  | { ok: false; reason: 'NOT_READY' | 'LOCKED' | 'NOT_FOUND' }
  | { ok: false; reason: 'UNAUTHENTICATED'; error: string }
  | { ok: false; reason: 'FAILED'; error: string };

async function startMatchIfReady(): Promise<StartMatchResult> {
  const db = admin.firestore();
  const ref = db.doc(MATCH_DOC_PATH);

  // 1) lock en tx
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false as const, reason: 'NOT_FOUND' as const };

    const cur = snap.data() as any;

    if (cur.estado === 'en_curso') return { ok: false as const, reason: 'LOCKED' as const };
    if (cur.startInProgress === true) return { ok: false as const, reason: 'LOCKED' as const };

    const t1: string[] = cur?.team1?.players ?? [];
    const t2: string[] = cur?.team2?.players ?? [];
    const map: string | null = cur?.map ?? null;

    const ready =
      cur?.estado === 'seleccionando_mapa' && t1.length === 5 && t2.length === 5 && !!map;

    if (!ready) return { ok: false as const, reason: 'NOT_READY' as const };

    tx.update(ref, {
      startInProgress: true,
      startRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
      startError: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { ok: true as const };
  });

  if ('ok' in claimed && claimed.ok !== true) return claimed;

  // 2) ejecutar side-effects fuera de tx
  try {
    const snap = await ref.get();
    if (!snap.exists) return { ok: false, reason: 'NOT_FOUND' };

    const cur = snap.data() as any;
    const t1: string[] = cur?.team1?.players ?? [];
    const t2: string[] = cur?.team2?.players ?? [];
    const map: string | null = cur?.map ?? null;

    const stillReady =
      cur?.estado === 'seleccionando_mapa' && t1.length === 5 && t2.length === 5 && !!map;

    if (!stillReady) {
      await ref.update({
        startInProgress: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { ok: false, reason: 'NOT_READY' };
    }

    const matchJsonResult = await buildMatchJson(map, cur?.team1 ?? {}, cur?.team2 ?? {});
    if (!matchJsonResult.ok) {
      await ref.update({
        startInProgress: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { ok: false, reason: 'NOT_READY' };
    }

    const matchConfigUrl = `https://${getPublicBaseUrl()}/api/match/config`;
    const cmd = `matchzy_loadmatch_url "${matchConfigUrl}"`;
    console.log("CMD:",cmd);
    await pteroSendCommand(cmd);

    await ref.update({
      estado: 'en_curso',
      startInProgress: false,
      matchConfigUrl,
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { ok: true, command: cmd, matchConfigUrl };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    logger.error(`startMatchIfReady failed: ${msg}`);

    if (err instanceof PterodactylCommandError && err.status === 401) {
      const authMsg =
        'Pterodactyl unauthenticated: verify PTERO_CLIENT_KEY, PTERO_SERVER_ID, and PTERO_PANEL_ORIGIN';
      await ref.update({
        startInProgress: false,
        startError: authMsg,
        startFailedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return { ok: false, reason: 'UNAUTHENTICATED', error: authMsg };
    }

    await ref.update({
      startInProgress: false,
      startError: msg,
      startFailedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { ok: false, reason: 'FAILED', error: msg };
  }
}

// =====================================================
// AUTO START MATCH (trigger) — usa startMatchIfReady()
// =====================================================
export const autoStartMatch = onDocumentWritten(
  {
    document: MATCH_DOC_PATH,
    region: 'us-central1',
    secrets: [PTERO_CLIENT_KEY, PTERO_SERVER_ID, PTERO_PANEL_ORIGIN, PUBLIC_BASE_URL],
  },
  async (event) => {
    const before = event.data?.before;
    const after = event.data?.after;
    if (!after?.exists) return;

    const match = after.data() as any;

    // quick check (barato) para no invocar siempre
    const t1: string[] = match?.team1?.players ?? [];
    const t2: string[] = match?.team2?.players ?? [];
    const map: string | null = match?.map ?? null;

    const ready =
      match?.estado === 'seleccionando_mapa' && t1.length === 5 && t2.length === 5 && !!map;

    if (!ready) return;

    if (before?.exists) {
      const prev = before.data() as any;
      const prevT1: string[] = prev?.team1?.players ?? [];
      const prevT2: string[] = prev?.team2?.players ?? [];
      const prevMap: string | null = prev?.map ?? null;
      const prevReady =
        prev?.estado === 'seleccionando_mapa' &&
        prevT1.length === 5 &&
        prevT2.length === 5 &&
        !!prevMap;

      if (prevReady) return;
    }

    await startMatchIfReady();
  }
);

export const helloWorld = onRequest((request, response) => {
  logger.info('Hello logs!', { structuredData: true });
  response.send('Hello from Firebase!');
});

// ====== API principal ======
export const api = onRequest(
  {
    secrets: [
      STEAM_API_KEY,
      PTERO_CLIENT_KEY,
      PTERO_SERVER_ID,
      PTERO_PANEL_ORIGIN,
      GAME_SERVER_HOST,
      GAME_SERVER_PORT,
      GAME_SERVER_SPECTATE_PORT,
      PUBLIC_BASE_URL,
    ],
    region: 'us-central1',
  },
  async (req, res): Promise<void> => {
    const baseUrl = getBaseUrl(req);

    const rawPath = req.path || '/';
    const path = rawPath.replace(/^\/+/, '').replace(/^api\/+/, '');

    // ======================
    // Steam OpenID start
    // ======================
    if (path === 'auth/steam/start') {
      const redirect = (req.query.redirect as string | undefined) || '';

      const returnToUrl = new URL(`${baseUrl}/api/auth/steam/callback`);
      if (redirect) returnToUrl.searchParams.set('redirect', redirect);

      const realm = baseUrl + '/';

      const steamUrl = new URL(STEAM_OPENID_ENDPOINT);
      steamUrl.searchParams.set('openid.ns', 'http://specs.openid.net/auth/2.0');
      steamUrl.searchParams.set('openid.mode', 'checkid_setup');
      steamUrl.searchParams.set('openid.return_to', returnToUrl.toString());
      steamUrl.searchParams.set('openid.realm', realm);
      steamUrl.searchParams.set(
        'openid.identity',
        'http://specs.openid.net/auth/2.0/identifier_select'
      );
      steamUrl.searchParams.set(
        'openid.claimed_id',
        'http://specs.openid.net/auth/2.0/identifier_select'
      );

      res.redirect(302, steamUrl.toString());
      return;
    }

    // ======================
    // Steam OpenID dev login
    // ======================
    if (path === 'auth/steam/dev') {
      const host = req.get('x-forwarded-host') || req.get('host');
      if (!isDevHost(host)) {
        res.status(403).send('Dev login only available on local/dev hosts');
        return;
      }

      const steamId = String(req.query.steamId ?? '').trim();
      if (!/^\d{15,20}$/.test(steamId)) {
        res.status(400).send('Invalid steamId');
        return;
      }

      const uid = `steam:${steamId}`;
      const customToken = await admin.auth().createCustomToken(uid, { steamId, dev: true });
      const redirect = (req.query.redirect as string | undefined) || '';
      if (!redirect) {
        res.status(200).send(customToken);
        return;
      }

      const url = new URL(redirect);
      url.searchParams.set('token', customToken);
      res.redirect(302, url.toString());
      return;
    }

    // ======================
    // Steam OpenID callback
    // ======================
    if (path === 'auth/steam/callback') {
      try {
        const mode = req.query['openid.mode'] as string | undefined;
        if (!mode) {
          res.status(400).send('Missing openid.mode');
          return;
        }

        if (mode === 'cancel') {
          const redirect = (req.query.redirect as string | undefined) || '';
          if (redirect) {
            res.redirect(302, `${redirect}?error=${encodeURIComponent('steam_cancelled')}`);
            return;
          }
          res.status(401).send('Steam login cancelled');
          return;
        }

        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(req.query)) {
          if (Array.isArray(v)) {
            for (const vv of v) params.append(k, String(vv));
          } else if (v != null) {
            params.append(k, String(v));
          }
        }
        params.set('openid.mode', 'check_authentication');

        const verifyResp = await fetch(STEAM_OPENID_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        });

        const text = await verifyResp.text();
        const isValid = text.includes('is_valid:true');
        if (!isValid) {
          const redirect = (req.query.redirect as string | undefined) || '';
          if (redirect) {
            res.redirect(302, `${redirect}?error=${encodeURIComponent('steam_invalid')}`);
            return;
          }
          res.status(401).send('Invalid Steam OpenID response');
          return;
        }

        const claimedId = req.query['openid.claimed_id'] as string | undefined;
        const steamId = extractSteamId(claimedId);
        if (!steamId) {
          const redirect = (req.query.redirect as string | undefined) || '';
          if (redirect) {
            res.redirect(302, `${redirect}?error=${encodeURIComponent('steam_no_id')}`);
            return;
          }
          res.status(400).send('Could not extract SteamID');
          return;
        }

        const uid = `steam:${steamId}`;
        const customToken = await admin.auth().createCustomToken(uid, { steamId });

        const redirect = (req.query.redirect as string | undefined) || '';
        if (!redirect) {
          res.status(200).send(customToken);
          return;
        }

        const url = new URL(redirect);
        url.searchParams.set('token', customToken);
        res.redirect(302, url.toString());
        return;
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        const stack = err?.stack ? String(err.stack) : '';

        logger.error(`Steam callback error: ${msg}`);
        if (stack) logger.error(stack);

        const redirect = (req.query.redirect as string | undefined) || '';
        const detail = encodeURIComponent(msg);

        if (redirect) {
          res.redirect(
            302,
            `${redirect}?error=${encodeURIComponent('steam_exception')}&detail=${detail}`
          );
          return;
        }

        res.status(500).send(`Steam callback exception: ${msg}`);
        return;
      }
    }

    // ======================
    // Server connection: /api/server/connection
    // ======================
    if (path === 'server/connection') {
      const connection = getServerConnectionInfo();
      if (!connection.ok) {
        res.status(500).send(connection.error);
        return;
      }

      res.status(200).json(connection);
      return;
    }

    // ======================
    // Steam profile: /api/steam/me?steamId=...
    // ======================
    if (path === 'steam/me') {
      try {
        const steamId = (req.query.steamId as string | undefined) || '';
        if (!steamId) {
          res.status(400).send('Missing steamId');
          return;
        }

        const apiKey = STEAM_API_KEY.value();
        if (!apiKey) {
          res.status(500).send('Missing STEAM_API_KEY secret');
          return;
        }

        const url =
          `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(
            apiKey
          )}&steamids=${encodeURIComponent(steamId)}`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);
        try {
          const r = await fetch(url, { signal: controller.signal });
          if (!r.ok) {
            res.status(502).send(`Steam API error: ${r.status}`);
            return;
          }

          const data = await r.json();
          const player = data?.response?.players?.[0];
          if (!player) {
            res.status(404).send('Player not found');
            return;
          }

          res.status(200).json({
            steamId: player.steamid,
            personaName: player.personaname,
            avatar: player.avatarfull || player.avatarmedium || player.avatar,
            profileUrl: player.profileurl,
          });
          return;
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') {
          res.status(504).send('Steam API timeout');
          return;
        }
        logger.error(`steam/me error: ${e?.message ?? String(e)}`);
        res.status(500).send('steam/me exception');
        return;
      }
    }

    // ======================
    // LOAD MATCH (manual/debug): /api/match/load
    // ======================
    if (path === 'match/load') {
      try {
        const payload =
          typeof req.body === 'string'
            ? JSON.parse(req.body || '{}')
            : (req.body ?? {});

        if (payload?.num_maps !== undefined) {
          if (typeof payload.num_maps !== 'number') {
            res.status(400).send('num_maps must be a number');
            return;
          }
          if (payload.num_maps !== 1) {
            res.status(400).send('Only num_maps=1 is supported');
            return;
          }
        }

        const mapList = Array.isArray(payload?.maplist) ? payload.maplist : null;
        if (mapList && (mapList.length !== 1 || typeof mapList[0] !== 'string')) {
          res.status(400).send('maplist must be an array with a single map string');
          return;
        }

        const map = mapList?.[0] ?? payload?.map;
        const team1 = payload?.team1 ?? {};
        const team2 = payload?.team2 ?? {};

        const team1Normalized = normalizePlayers(team1?.players, (team1 as any)?.playerNames);
        const team2Normalized = normalizePlayers(team2?.players, (team2 as any)?.playerNames);

        const matchJsonResult = await buildMatchJson(map, team1, team2);
        if (!matchJsonResult.ok) {
          res.status(400).send(matchJsonResult.error);
          return;
        }

        const db = admin.firestore();
        const ref = db.doc(MATCH_DOC_PATH);

        await ref.set(
          {
            estado: 'seleccionando_mapa',
            map: matchJsonResult.match.maplist[0],
            team1: {
              name: matchJsonResult.match.team1.name,
              players: team1Normalized.ids,
              playerNames: team1Normalized.names,
            },
            team2: {
              name: matchJsonResult.match.team2.name,
              players: team2Normalized.ids,
              playerNames: team2Normalized.names,
            },
            queue: [],
            unassigned: [],
            turn: 'team1',
            mapTurn: 'team1',
            mapBanCount: 0,
            bannedMaps: [],
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: false }
        );

        const startResult = await startMatchIfReady();
        const connection = getServerConnectionInfo();

        if (startResult.ok) {
          res.status(200).json({
            ok: true,
            startResult,
            connection,
            match: matchJsonResult.match,
          });
          return;
        }

        if (startResult.reason === 'NOT_READY') {
          res.status(409).json({
            ok: false,
            startResult,
            connection,
            match: matchJsonResult.match,
          });
          return;
        }

        if (startResult.reason === 'LOCKED') {
          res.status(423).json({
            ok: false,
            startResult,
            connection,
            match: matchJsonResult.match,
          });
          return;
        }

        if (startResult.reason === 'NOT_FOUND') {
          res.status(404).json({
            ok: false,
            startResult,
            connection,
            match: matchJsonResult.match,
          });
          return;
        }

        if (startResult.reason === 'UNAUTHENTICATED') {
          res.status(502).json({
            ok: false,
            startResult,
            connection,
            match: matchJsonResult.match,
          });
          return;
        }

        res.status(502).json({
          ok: false,
          startResult,
          connection,
          match: matchJsonResult.match,
        });
        return;
      } catch (e: any) {
        res.status(400).send(`Invalid JSON body: ${e?.message ?? String(e)}`);
        return;
      }
    }

    // ======================
    // CANCEL MATCH: /api/match/cancel
    // ======================
    if (path === 'match/cancel') {
      if (req.method !== 'POST') {
        res.status(405).send('Method not allowed');
        return;
      }

      try {
        await pteroSendCommand('mp_restartgame 1');
        const db = admin.firestore();
        const ref = db.doc(MATCH_DOC_PATH);
        await ref.set(initialMatchDoc(), { merge: false });
        res.status(200).json({ ok: true });
        return;
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        logger.error(`match/cancel error: ${msg}`);
        res.status(502).send(`match/cancel error: ${msg}`);
        return;
      }
    }

    // ======================
    // MATCH JSON (current): /api/match/json
    // ======================
    if (path === 'match/json') {
      const matchResult = await getCurrentMatchJson();
      if (!matchResult.ok) {
        if (matchResult.reason === 'NOT_FOUND') {
          res.status(404).json(matchResult);
          return;
        }

        res.status(409).json(matchResult);
        return;
      }

      res.status(200).json(matchResult.match);
      return;
    }

    // ======================
    // MATCH JSON file (current): /api/match/config
    // ======================
    if (path === 'match/config') {
      const matchResult = await getCurrentMatchJson();
      if (!matchResult.ok) {
        if (matchResult.reason === 'NOT_FOUND') {
          res.status(404).json(matchResult);
          return;
        }

        res.status(409).json(matchResult);
        return;
      }

      res.set('cache-control', 'no-store');
      res.type('application/json').status(200).send(JSON.stringify(matchResult.match, null, 2));
      return;
    }

    // ======================
    // START MATCH (manual/debug): /api/match/start
    // ======================
    if (path === 'match/start') {
      const r = await startMatchIfReady();
      if (r.ok) {
        res.status(200).json(r);
      } else if (r.reason === 'NOT_READY') {
        res.status(409).json(r);
      } else if (r.reason === 'LOCKED') {
        res.status(423).json(r);
      } else if (r.reason === 'NOT_FOUND') {
        res.status(404).json(r);
      } else if (r.reason === 'UNAUTHENTICATED') {
        res.status(502).json(r);
      } else {
        res.status(500).json(r);
      }
      return;
    }

    res.status(404).send('Not found');
  }
);
