import { AsyncPipe } from '@angular/common';
import { Component, Input, inject } from '@angular/core';
import { doc, onSnapshot } from 'firebase/firestore';
import { Observable, of } from 'rxjs';
import { MatchDoc } from '../../core/match/match.service';
import { MatchService } from '../../core/match/match.service';
import { db } from '../../core/firebase/firebase';

type SteamMe = {
  steamId: string;
  personaName: string;
  avatar: string;
  profileUrl: string;
};

type ServerConnection = {
  connectUrl: string;
  spectateUrl: string;
};

@Component({
  standalone: true,
  selector: 'app-match-board',
  imports: [AsyncPipe],
  templateUrl: './match-board.component.html',
  styleUrl: './match-board.component.css',
})
export class MatchBoardComponent {
  private matchSvc = inject(MatchService);

  readonly mapPool = [
    'de_inferno',
    'de_mirage',
    'de_nuke',
    'de_overpass',
    'de_ancient',
    'de_vertigo',
    'de_anubis',
  ];

  private matchValue!: MatchDoc;
  @Input({ required: true }) set match(value: MatchDoc) {
    this.matchValue = value;
  }
  get match(): MatchDoc {
    return this.matchValue;
  }
  @Input({ required: true }) showDetails = true;

  // steamId del usuario logueado (para habilitar pick)
  @Input() mySteamId: string | null = null;

  // opcional (si lo pasás desde dashboard)
  @Input() leaderA: string | null = null;
  @Input() leaderB: string | null = null;
  @Input() connection: ServerConnection | null = null;
  @Input() profileOf?: (steamId: string) => Observable<SteamMe | null>;

  // UI state local
  busyPick = false;
  pickErr = '';
  busyBan = false;
  banErr = '';
  busyFinalize = false;
  finalizeErr = '';
  busyCancel = false;
  cancelErr = '';

  get teamA() {
    return this.match?.team1?.players ?? [];
  }
  get teamB() {
    return this.match?.team2?.players ?? [];
  }
  get queue() {
    return this.match?.queue ?? [];
  }

  get unassigned(): string[] {
    const anyMatch: any = this.match as any;
    return Array.isArray(anyMatch.unassigned) ? anyMatch.unassigned : [];
  }

  // líderes (preferimos inputs, si no vienen los inferimos)
  get leaderAId(): string | null {
    return this.leaderA ?? this.teamA[0] ?? null;
  }
  get leaderBId(): string | null {
    return this.leaderB ?? this.teamB[0] ?? null;
  }

  get turn(): 'team1' | 'team2' {
    const t: any = (this.match as any)?.turn;
    return t === 'team2' ? 'team2' : 'team1';
  }

  get mapTurn(): 'team1' | 'team2' {
    return this.match?.mapTurn === 'team2' ? 'team2' : 'team1';
  }

  get finalizeBy(): string[] {
    return Array.isArray(this.match?.finalizeBy) ? this.match.finalizeBy : [];
  }

  isLeaderA(id: string): boolean {
    return !!id && id === this.leaderAId;
  }

  isLeaderB(id: string): boolean {
    return !!id && id === this.leaderBId;
  }

  /** Soy líder y es mi turno? */
  get canPick(): boolean {
    if (this.match?.estado !== 'armando_equipos') return false;
    if (!this.mySteamId) return false;

    if (this.turn === 'team1') return this.mySteamId === this.leaderAId;
    return this.mySteamId === this.leaderBId;
  }

  /** Soy líder y es mi turno para banear? */
  get canBan(): boolean {
    if (this.match?.estado !== 'seleccionando_mapa') return false;
    if (this.match?.map) return false;
    if (!this.mySteamId) return false;

    if (this.mapTurn === 'team1') return this.mySteamId === this.leaderAId;
    return this.mySteamId === this.leaderBId;
  }

  get isParticipant(): boolean {
    if (!this.mySteamId) return false;
    return this.teamA.includes(this.mySteamId) || this.teamB.includes(this.mySteamId);
  }

  get canFinalize(): boolean {
    if (this.match?.estado !== 'en_curso') return false;
    if (!this.mySteamId) return false;
    return this.mySteamId === this.leaderAId || this.mySteamId === this.leaderBId;
  }

  get canCancel(): boolean {
    if (this.match?.estado !== 'en_curso') return false;
    if (!this.mySteamId) return false;
    return this.mySteamId === this.leaderAId || this.mySteamId === this.leaderBId;
  }

  get hasFinalized(): boolean {
    if (!this.mySteamId) return false;
    return this.finalizeBy.includes(this.mySteamId);
  }

  get bannedMaps(): string[] {
    return Array.isArray(this.match?.bannedMaps) ? this.match.bannedMaps : [];
  }

  isBanned(mapName: string): boolean {
    return this.bannedMaps.includes(mapName);
  }

  /** Lista de disponibles en el centro */
  get availableIds(): string[] {
    const list = this.unassigned.length ? this.unassigned : this.queue;
    // no mostrar líderes ahí por las dudas
    const la = this.leaderAId;
    const lb = this.leaderBId;
    return list.filter((x) => x && x !== la && x !== lb);
  }

  private profileRef(steamId: string) {
    return doc(db, 'steamProfile', steamId);
  }

  readonly fallbackAvatar = '/steam-logo.png';

  avatarSrc(profile: SteamMe | null): string {
    if (profile?.avatar?.trim()) {
      return profile.avatar;
    }
    return this.fallbackAvatar;
  }

  displayName(profile: SteamMe | null): string {
    if (profile?.personaName?.trim()) {
      return profile.personaName;
    }
    return 'Jugador';
  }

  profile$(steamId: string): Observable<SteamMe | null> {
    if (!steamId) {
      return of(null);
    }
    if (this.profileOf) {
      return this.profileOf(steamId);
    }
    return new Observable<SteamMe | null>((subscriber) => {
      const unsubscribe = onSnapshot(
        this.profileRef(steamId),
        (snap) => {
          if (!snap.exists()) {
            subscriber.next(null);
            return;
          }
          const data = snap.data() as Partial<SteamMe>;
          const normalized: SteamMe = {
            steamId: data.steamId ?? steamId,
            personaName: data.personaName ?? '',
            avatar: data.avatar ?? '',
            profileUrl: data.profileUrl ?? '',
          };
          if (!normalized.steamId) {
            subscriber.next(null);
            return;
          }
          subscriber.next(normalized);
        },
        (err) => {
          console.error('Match board profile onSnapshot error:', err);
          subscriber.next(null);
        }
      );
      return () => unsubscribe();
    });
  }

  async onBanMap(mapName: string): Promise<void> {
    if (!this.canBan || this.busyBan) return;
    if (!mapName || this.isBanned(mapName)) return;

    try {
      this.busyBan = true;
      this.banErr = '';

      await this.matchSvc.banMap(this.mySteamId!, mapName);
    } catch (e: any) {
      this.banErr = e?.message ?? String(e);
    } finally {
      this.busyBan = false;
    }
  }

  async onPick(id: string): Promise<void> {
    if (!this.canPick || this.busyPick) return;
    if (!id) return;

    try {
      this.busyPick = true;
      this.pickErr = '';

      await this.matchSvc.pickPlayer(this.mySteamId!, id);
    } catch (e: any) {
      this.pickErr = e?.message ?? String(e);
    } finally {
      this.busyPick = false;
    }
  }

  async onFinalize(): Promise<void> {
    if (!this.canFinalize || this.hasFinalized) return;

    try {
      this.busyFinalize = true;
      this.finalizeErr = '';

      await this.matchSvc.requestFinalizeMatch(this.mySteamId!);
    } catch (e: any) {
      this.finalizeErr = e?.message ?? String(e);
    } finally {
      this.busyFinalize = false;
    }
  }

  async onCancel(): Promise<void> {
    if (!this.canCancel) return;

    try {
      this.busyCancel = true;
      this.cancelErr = '';
      await this.matchSvc.cancelMatch();
    } catch (e: any) {
      this.cancelErr = e?.message ?? String(e);
    } finally {
      this.busyCancel = false;
    }
  }
}
