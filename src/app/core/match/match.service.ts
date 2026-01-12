import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import {
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
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
  mapPool?: string[];
  bannedMaps?: string[];
  mapTurn?: 'team1' | 'team2';
  mapBanIndex?: number;

  // campos “extra” que ya estás usando en functions
  unassigned?: string[];
  turn?: 'team1' | 'team2';
  finalizeBy?: string[];

  updatedAt?: any;
};

const MATCH_PATH = ['matches', 'current'] as const;
const DEFAULT_MAP_POOL = [
  'de_inferno',
  'de_mirage',
  'de_nuke',
  'de_overpass',
  'de_ancient',
  'de_vertigo',
  'de_anubis',
] as const;

function initialMatch(): MatchDoc {
  return {
    estado: 'esperando_jugadores',
    map: null,
    team1: { name: 'Team A', players: [] },
    team2: { name: 'Team B', players: [] },
    queue: [],
    mapPool: [],
    bannedMaps: [],
    mapTurn: 'team1',
    mapBanIndex: 0,
    updatedAt: serverTimestamp(),
  };
}

@Injectable({ providedIn: 'root' })
export class MatchService {
  readonly matchRef = doc(db, ...MATCH_PATH);

  private readonly _match$ = new BehaviorSubject<MatchDoc | null>(null);
  readonly match$ = this._match$.asObservable();

  private unsub: (() => void) | null = null;

  /**
   * Llamalo 1 vez (por ej. al entrar al Dashboard):
   * - crea el singleton si no existe
   * - se suscribe realtime al doc
   */
  async ensureAndSubscribe(): Promise<void> {
    const snap = await getDoc(this.matchRef);
    if (!snap.exists()) {
      await setDoc(this.matchRef, initialMatch(), { merge: false });
    }

    if (!this.unsub) {
      this.unsub = onSnapshot(
        this.matchRef,
        (s) => {
          this._match$.next((s.data() as MatchDoc) ?? null);
        },
        (err: FirestoreError) => {
          console.error('Match onSnapshot error:', err);
          this._match$.next(null);
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

      if (match.estado !== 'esperando_jugadores') {
        throw new Error(`No se puede unirse: estado actual = ${match.estado}`);
      }

      const q = Array.isArray(match.queue) ? [...match.queue] : [];
      if (q.includes(steamId)) return; // idempotente

      if (q.length >= 10) {
        throw new Error('La queue ya está completa (10 jugadores).');
      }

      q.push(steamId);

      tx.update(this.matchRef, {
        queue: q,
        updatedAt: serverTimestamp(),
      });
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
        update.mapBanIndex = 0;
        update.bannedMaps = [];
        update.mapPool = Array.isArray(match.mapPool) ? [...match.mapPool] : [];
      }

      tx.update(this.matchRef, update);
    });
  }

  dispose(): void {
    if (this.unsub) this.unsub();
    this.unsub = null;
    this._match$.next(null);
  }
}
