import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import {
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  FirestoreError,
} from 'firebase/firestore';
import { db } from '../firebase/firebase';

export type MatchEstado =
  | 'esperando_jugadores'
  | 'seleccionando_lideres'
  | 'armando_equipos'
  | 'seleccionando_mapa'
  | 'en_curso';

export type MatchDoc = {
  estado: MatchEstado;
  map: string | null;

  mapPool?: string[];
  bannedMaps?: string[];
  mapTurn?: 'team1' | 'team2' | null;
  mapBanCount?: number;

  team1: { name: string; players: string[] };
  team2: { name: string; players: string[] };

  queue: string[];

  // campos “extra” que ya estás usando en functions
  unassigned?: string[];
  turn?: 'team1' | 'team2';
  finalizeBy?: string[];
  leaderSelectionAt?: Timestamp | null;
  publishInProgress?: boolean;
  publishedAt?: any;

  updatedAt?: any;
};

const MATCH_DRAFT_PATH = ['matches', 'draft'] as const;
const MATCH_CURRENT_PATH = ['matches', 'current'] as const;
const DEFAULT_MAP_POOL = [
  'de_inferno',
  'de_mirage',
  'de_nuke',
  'de_overpass',
  'de_ancient',
  'de_vertigo',
  'de_anubis',
] as const;

const VALID_ESTADOS: MatchEstado[] = [
  'esperando_jugadores',
  'seleccionando_lideres',
  'armando_equipos',
  'seleccionando_mapa',
  'en_curso',
];

function initialMatch(): MatchDoc {
  return {
    estado: 'esperando_jugadores',
    map: null,
    team1: { name: 'Team A', players: [] },
    team2: { name: 'Team B', players: [] },
    queue: [],
    mapPool: [...DEFAULT_MAP_POOL],
    bannedMaps: [],
    mapTurn: 'team1',
    mapBanCount: 0,
    leaderSelectionAt: null,
    publishInProgress: false,
    publishedAt: null,
    updatedAt: serverTimestamp(),
  };
}

function isValidEstado(estado: unknown): estado is MatchEstado {
  return typeof estado === 'string' && VALID_ESTADOS.includes(estado as MatchEstado);
}

function patchMissingFields(match: Partial<MatchDoc>): Partial<MatchDoc> {
  const patch: Partial<MatchDoc> = {};
  if (!isValidEstado(match.estado)) {
    patch.estado = 'esperando_jugadores';
  }
  if (match.map === undefined) {
    patch.map = null;
  }
  if (!Array.isArray(match.queue)) {
    patch.queue = [];
  }
  if (!Array.isArray(match.mapPool)) {
    patch.mapPool = [...DEFAULT_MAP_POOL];
  }
  if (!Array.isArray(match.bannedMaps)) {
    patch.bannedMaps = [];
  }
  if (!match.team1 || typeof match.team1 !== 'object') {
    patch.team1 = { name: 'Team A', players: [] };
  } else {
    const team1Patch: Partial<MatchDoc['team1']> = {};
    if (!match.team1.name) team1Patch.name = 'Team A';
    if (!Array.isArray(match.team1.players)) team1Patch.players = [];
    if (Object.keys(team1Patch).length) {
      patch.team1 = { ...(match.team1 as MatchDoc['team1']), ...team1Patch };
    }
  }
  if (!match.team2 || typeof match.team2 !== 'object') {
    patch.team2 = { name: 'Team B', players: [] };
  } else {
    const team2Patch: Partial<MatchDoc['team2']> = {};
    if (!match.team2.name) team2Patch.name = 'Team B';
    if (!Array.isArray(match.team2.players)) team2Patch.players = [];
    if (Object.keys(team2Patch).length) {
      patch.team2 = { ...(match.team2 as MatchDoc['team2']), ...team2Patch };
    }
  }
  return patch;
}

function normalizeIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return ids
    .map((id) => (id === null || id === undefined ? '' : String(id)))
    .filter((id) => id.length > 0);
}

function normalizeMatchIds(match: MatchDoc): MatchDoc {
  return {
    ...match,
    team1: {
      ...match.team1,
      players: normalizeIds(match.team1?.players),
    },
    team2: {
      ...match.team2,
      players: normalizeIds(match.team2?.players),
    },
    queue: normalizeIds(match.queue),
    unassigned: normalizeIds(match.unassigned),
    finalizeBy: normalizeIds(match.finalizeBy),
  };
}

@Injectable({ providedIn: 'root' })
export class MatchService {
  readonly matchRef = doc(db, ...MATCH_DRAFT_PATH);
  readonly currentRef = doc(db, ...MATCH_CURRENT_PATH);

  private readonly _match$ = new BehaviorSubject<MatchDoc | null>(null);
  readonly match$ = this._match$.asObservable();

  private unsub: (() => void) | null = null;
  private selectingLeaders = false;
  private publishing = false;

  constructor(private zone: NgZone) {}

  /**
   * Llamalo 1 vez (por ej. al entrar al Dashboard):
   * - crea el singleton si no existe
   * - se suscribe realtime al doc
   */
  async ensureAndSubscribe(): Promise<void> {
    const snap = await getDoc(this.matchRef);
    if (!snap.exists()) {
      await setDoc(this.matchRef, initialMatch(), { merge: false });
    } else {
      const data = snap.data() as Partial<MatchDoc>;
      const patch = patchMissingFields(data);
      if (Object.keys(patch).length > 0) {
        await setDoc(this.matchRef, patch as MatchDoc, { merge: true });
      }
    }

    if (!this.unsub) {
      this.unsub = onSnapshot(
        this.matchRef,
        (s) => {
          const data = (s.data() as MatchDoc) ?? null;
          const normalized = data ? normalizeMatchIds(data) : null;
          this.zone.run(() => {
            this._match$.next(normalized);
          });
          if (normalized) {
            this.maybeSelectLeaders(normalized).catch(() => {});
            this.maybePublishMatch(normalized).catch(() => {});
          }
        },
        (err: FirestoreError) => {
          console.error('Match onSnapshot error:', err);
          this.zone.run(() => {
            this._match$.next(null);
          });
        }
      );
    }
  }

  async joinQueue(steamId: string): Promise<void> {
    if (!steamId) return;

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(this.matchRef);

      if (!snap.exists()) {
        tx.set(this.matchRef, initialMatch(), { merge: false });
        return;
      }

      const match = snap.data() as MatchDoc;

      const estado = isValidEstado(match.estado) ? match.estado : 'esperando_jugadores';
      if (estado !== 'esperando_jugadores') {
        throw new Error(`No se puede unirse: estado actual = ${estado}`);
      }

      const q = Array.isArray(match.queue) ? [...match.queue] : [];
      if (q.includes(steamId)) return; // idempotente

      if (q.length >= 10) {
        throw new Error('La queue ya está completa (10 jugadores).');
      }

      q.push(steamId);

      const update: Partial<MatchDoc> = {
        queue: q,
        updatedAt: serverTimestamp(),
      };

      if (q.length === 10) {
        update.estado = 'seleccionando_lideres';
        update.team1 = { name: 'Team A', players: [] };
        update.team2 = { name: 'Team B', players: [] };
        update.unassigned = [];
        update.turn = 'team1';
        update.leaderSelectionAt = Timestamp.fromMillis(Date.now() + 10_000);
      }

      if (!isValidEstado(match.estado) && !update.estado) {
        update.estado = 'esperando_jugadores';
      }
      tx.update(this.matchRef, update);
    });
  }

  async leaveQueue(steamId: string): Promise<void> {
    if (!steamId) return;

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(this.matchRef);
      if (!snap.exists()) return;

      const match = snap.data() as MatchDoc;
      if (match.estado !== 'esperando_jugadores') {
        // por ahora solo permitimos salir cuando está esperando
        return;
      }

      const q = Array.isArray(match.queue) ? [...match.queue] : [];
      const next = q.filter((x) => x !== steamId);

      tx.update(this.matchRef, {
        queue: next,
        updatedAt: serverTimestamp(),
      });
    });
  }

  /**
   * Pick REAL por transacción:
   * - solo en estado armando_equipos
   * - solo si sos líder del team que tiene el turno
   * - solo si el jugador está en unassigned (o fallback queue si todavía no existe unassigned)
   * - alterna el turno
   * - cuando ambos equipos llegan a 5 -> pasa a seleccionando_mapa
   */
  async pickPlayer(mySteamId: string, pickedSteamId: string): Promise<void> {
    if (!mySteamId || !pickedSteamId) return;

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(this.matchRef);
      if (!snap.exists()) throw new Error('Match no existe.');

      const match = snap.data() as MatchDoc;

      if (match.estado !== 'armando_equipos') {
        throw new Error(`No se puede pickear: estado = ${match.estado}`);
      }

      const team1 = match.team1?.players ? [...match.team1.players] : [];
      const team2 = match.team2?.players ? [...match.team2.players] : [];
      const leaderA = team1[0] ?? null;
      const leaderB = team2[0] ?? null;

      if (!leaderA || !leaderB) {
        throw new Error('No hay líderes definidos todavía.');
      }

      const turn: 'team1' | 'team2' = (match.turn as any) || 'team1';

      // Validar que sos el líder y es tu turno
      if (turn === 'team1') {
        if (mySteamId !== leaderA) throw new Error('No sos el líder de Team A o no es tu turno.');
      } else {
        if (mySteamId !== leaderB) throw new Error('No sos el líder de Team B o no es tu turno.');
      }

      // Disponibles: unassigned (si existe) sino queue
      const unassigned = Array.isArray(match.unassigned)
        ? [...match.unassigned]
        : Array.isArray(match.queue)
          ? [...match.queue]
          : [];

      if (!unassigned.includes(pickedSteamId)) {
        throw new Error('Ese jugador ya no está disponible para pick.');
      }

      // No se puede pickearse a uno mismo si sos líder (normalmente no debería estar en unassigned)
      if (pickedSteamId === leaderA || pickedSteamId === leaderB) {
        throw new Error('No podés pickear a un líder.');
      }

      // No duplicados
      if (team1.includes(pickedSteamId) || team2.includes(pickedSteamId)) {
        throw new Error('Ese jugador ya está en un equipo.');
      }

      // Límite 5 por equipo
      if (turn === 'team1' && team1.length >= 5) throw new Error('Team A ya está completo.');
      if (turn === 'team2' && team2.length >= 5) throw new Error('Team B ya está completo.');

      // Aplicar pick
      const nextUnassigned = unassigned.filter((x) => x !== pickedSteamId);

      let nextTeam1 = team1;
      let nextTeam2 = team2;

      if (turn === 'team1') nextTeam1 = [...team1, pickedSteamId];
      else nextTeam2 = [...team2, pickedSteamId];

      // Alternar turno (si el otro equipo ya está completo, igual alternamos; si querés, lo ajustamos después)
      const nextTurn: 'team1' | 'team2' = turn === 'team1' ? 'team2' : 'team1';

      // ¿Se completaron ambos equipos?
      const bothFull = nextTeam1.length === 5 && nextTeam2.length === 5;

      const update: any = {
        team1: { ...(match.team1 ?? { name: 'Team A' }), players: nextTeam1 },
        team2: { ...(match.team2 ?? { name: 'Team B' }), players: nextTeam2 },
        unassigned: nextUnassigned,
        turn: nextTurn,
        updatedAt: serverTimestamp(),
      };

      if (bothFull) {
        update.estado = 'seleccionando_mapa';
        update.queue = []; // ya no se usa queue en esta fase
        update.unassigned = [];
        update.mapTurn = 'team1';
        update.mapBanCount = 0;
        update.bannedMaps = [];
        update.mapPool = Array.isArray(match.mapPool)
          ? [...match.mapPool]
          : [...DEFAULT_MAP_POOL];
      }

      tx.update(this.matchRef, update);
    });
  }

  /**
   * Baneo de mapas:
   * - solo en estado seleccionando_mapa
   * - solo líder del turno
   * - no permite banear ya baneados
   * - cuando queda 1 mapa -> se define match.map
   */
  async banMap(mySteamId: string, mapName: string): Promise<void> {
    if (!mySteamId || !mapName) return;

    const banOrder: Array<'team1' | 'team2'> = [
      'team1',
      'team1',
      'team2',
      'team2',
      'team1',
      'team2',
    ];

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(this.matchRef);
      if (!snap.exists()) throw new Error('Match no existe.');

      const match = snap.data() as MatchDoc;

      if (match.estado !== 'seleccionando_mapa') {
        throw new Error(`No se puede banear: estado = ${match.estado}`);
      }

      const team1 = match.team1?.players ?? [];
      const team2 = match.team2?.players ?? [];
      const leaderA = team1[0] ?? null;
      const leaderB = team2[0] ?? null;

      if (!leaderA || !leaderB) {
        throw new Error('No hay líderes definidos.');
      }

      const banned = Array.isArray(match.bannedMaps) ? [...match.bannedMaps] : [];
      const banIndex = banned.length;
      const expectedTurn = banOrder[banIndex];

      if (!expectedTurn) {
        throw new Error('No hay más mapas para banear.');
      }

      if (expectedTurn === 'team1' && mySteamId !== leaderA) {
        throw new Error('No sos el líder de Team A o no es tu turno.');
      }
      if (expectedTurn === 'team2' && mySteamId !== leaderB) {
        throw new Error('No sos el líder de Team B o no es tu turno.');
      }

      const pool = Array.isArray(match.mapPool) && match.mapPool.length > 0
        ? [...match.mapPool]
        : [...DEFAULT_MAP_POOL];

      if (!pool.includes(mapName)) {
        throw new Error('Ese mapa no está en el pool.');
      }

      if (banned.includes(mapName)) {
        throw new Error('Ese mapa ya está baneado.');
      }

      const nextBanned = [...banned, mapName];
      const remaining = pool.filter((m) => !nextBanned.includes(m));

      if (remaining.length === 0) {
        throw new Error('No quedan mapas disponibles.');
      }

      const banCount = banIndex + 1;
      const nextTurn = banOrder[banIndex + 1] ?? null;

      const update: any = {
        bannedMaps: nextBanned,
        mapTurn: nextTurn,
        mapBanCount: banCount,
        mapPool: pool,
        updatedAt: serverTimestamp(),
      };

      if (remaining.length === 1) {
        update.map = remaining[0];
      }

      tx.update(this.matchRef, update);
    });

    await this.maybePublishMatch();
  }

  /**
   * Confirmación de fin de match por líderes:
   * - solo en estado en_curso
   * - cuando ambos líderes confirman -> reset al estado inicial
   */
  async requestFinalizeMatch(mySteamId: string): Promise<void> {
    if (!mySteamId) return;

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(this.matchRef);
      if (!snap.exists()) throw new Error('Match no existe.');

      const match = snap.data() as MatchDoc;

      if (match.estado !== 'en_curso') {
        throw new Error(`No se puede finalizar: estado = ${match.estado}`);
      }

      const team1 = match.team1?.players ?? [];
      const team2 = match.team2?.players ?? [];
      const leaderA = team1[0] ?? null;
      const leaderB = team2[0] ?? null;

      if (!leaderA || !leaderB) {
        throw new Error('No hay líderes definidos.');
      }

      if (mySteamId !== leaderA && mySteamId !== leaderB) {
        throw new Error('Solo los líderes pueden finalizar el match.');
      }

      const finalizedBy = Array.isArray(match.finalizeBy) ? [...match.finalizeBy] : [];
      if (finalizedBy.includes(mySteamId)) return;

      finalizedBy.push(mySteamId);

      const bothConfirmed = finalizedBy.includes(leaderA) && finalizedBy.includes(leaderB);

      if (bothConfirmed) {
        tx.set(this.matchRef, initialMatch(), { merge: false });
        tx.set(this.currentRef, initialMatch(), { merge: false });
        return;
      }

      tx.update(this.matchRef, {
        finalizeBy: finalizedBy,
        updatedAt: serverTimestamp(),
      });
    });
  }

  async cancelMatch(): Promise<void> {
    const r = await fetch('/api/match/cancel', { method: 'POST' });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`No se pudo cancelar el match (${r.status}) ${t}`.trim());
    }

    await setDoc(this.matchRef, initialMatch(), { merge: false });
  }

  private async maybeSelectLeaders(match?: MatchDoc): Promise<void> {
    if (this.selectingLeaders) return;
    const current = match ?? this._match$.getValue();
    if (!current) return;
    if (current.estado !== 'seleccionando_lideres') return;

    const selectionAt = current.leaderSelectionAt;
    if (!selectionAt) return;
    if (selectionAt.toMillis() > Date.now()) return;

    const queue = Array.isArray(current.queue) ? current.queue : [];
    if (queue.length !== 10) return;

    this.selectingLeaders = true;

    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(this.matchRef);
        if (!snap.exists()) return;
        const cur = snap.data() as MatchDoc;
        if (cur.estado !== 'seleccionando_lideres') return;

        const curQueue = Array.isArray(cur.queue) ? [...cur.queue] : [];
        if (curQueue.length !== 10) return;

        const shuffled = [...curQueue].sort(() => Math.random() - 0.5);
        const leaderA = shuffled[0];
        const leaderB = shuffled[1];

        const unassigned = curQueue.filter((id) => id !== leaderA && id !== leaderB);

        tx.update(this.matchRef, {
          estado: 'armando_equipos',
          team1: { name: 'Team A', players: [leaderA] },
          team2: { name: 'Team B', players: [leaderB] },
          unassigned,
          turn: 'team1',
          leaderSelectionAt: null,
          updatedAt: serverTimestamp(),
        });
      });
    } finally {
      this.selectingLeaders = false;
    }
  }

  private async maybePublishMatch(match?: MatchDoc): Promise<void> {
    if (this.publishing) return;
    const current = match ?? this._match$.getValue();
    if (!current) return;
    if (current.publishInProgress || current.publishedAt) return;
    if (current.estado !== 'seleccionando_mapa') return;

    const t1 = current.team1?.players ?? [];
    const t2 = current.team2?.players ?? [];
    if (t1.length !== 5 || t2.length !== 5) return;
    if (!current.map) return;

    this.publishing = true;

    try {
      const result = await runTransaction(db, async (tx) => {
        const snap = await tx.get(this.matchRef);
        if (!snap.exists()) return null;

        const cur = snap.data() as MatchDoc;
        if (cur.publishInProgress || cur.publishedAt) return null;
        if (cur.estado !== 'seleccionando_mapa') return null;

        const curT1 = cur.team1?.players ?? [];
        const curT2 = cur.team2?.players ?? [];
        if (curT1.length !== 5 || curT2.length !== 5) return null;
        if (!cur.map) return null;

        tx.update(this.matchRef, {
          publishInProgress: true,
          updatedAt: serverTimestamp(),
        });

        return cur;
      });

      if (!result) return;

      const publishPayload: MatchDoc = {
        estado: result.estado,
        map: result.map,
        team1: result.team1,
        team2: result.team2,
        queue: [],
        mapPool: result.mapPool ?? [...DEFAULT_MAP_POOL],
        bannedMaps: result.bannedMaps ?? [],
        mapTurn: result.mapTurn ?? null,
        mapBanCount: result.mapBanCount ?? 0,
        unassigned: result.unassigned ?? [],
        turn: result.turn ?? 'team1',
        updatedAt: serverTimestamp(),
      };

      await setDoc(this.currentRef, publishPayload, { merge: false });

      await setDoc(
        this.matchRef,
        {
          publishInProgress: false,
          publishedAt: serverTimestamp(),
          estado: 'en_curso',
          updatedAt: serverTimestamp(),
        } as Partial<MatchDoc>,
        { merge: true }
      );
    } finally {
      this.publishing = false;
    }
  }

  dispose(): void {
    if (this.unsub) this.unsub();
    this.unsub = null;
    this._match$.next(null);
  }
}
