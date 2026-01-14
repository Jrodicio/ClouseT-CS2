import { Component, DestroyRef, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AsyncPipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';

import { AuthService } from '../../core/auth/auth.service';
import { MatchService, MatchDoc } from '../../core/match/match.service';
import { MatchBoardComponent } from './match-board.component';
import { db } from '../../core/firebase/firebase';

type SteamMe = {
  steamId: string;
  personaName: string;
  avatar: string;
  profileUrl: string;
};

type ServerConnection = {
  host: string;
  port: number;
  spectatePort: number;
  connectUrl: string;
  spectateUrl: string;
};

@Component({
  standalone: true,
  selector: 'app-dashboard',
  imports: [AsyncPipe, MatchBoardComponent],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.css'],
})
export class DashboardComponent {
  auth = inject(AuthService);
  matchSvc = inject(MatchService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  watchMatch = false;
  readonly serverConnection: ServerConnection = {
    host: '45.235.98.222',
    port: 27159,
    spectatePort: 27159,
    connectUrl: 'steam://connect/45.235.98.222:27159',
    spectateUrl: 'steam://connect/45.235.98.222:27159',
  };

  // Steam cache
  steamMe: SteamMe | null = null;
  steamErr = '';
  steamRefreshErr = '';
  steamRefreshBusy = false;
  private profileCache = new Map<string, SteamMe>();
  private inflight = new Set<string>();

  match$ = this.matchSvc.match$;

  constructor() {
    // 1) asegurar doc + realtime
    this.matchSvc.ensureAndSubscribe().catch((e) => console.error('ensureAndSubscribe error', e));

    // 2) Prefetch perfiles cuando cambia el match
    this.matchSvc.match$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((m) => {
        if (!m) return;

        const ids = new Set<string>([
          ...(m.team1?.players ?? []),
          ...(m.team2?.players ?? []),
          ...(m.queue ?? []),
          ...(((m as any).unassigned ?? []) as string[]),
        ]);

        for (const id of ids) this.ensureProfile(id).catch(() => {});
      });

    // 3) Cargar mi perfil auto
    this.auth.user$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((u) => {
        const sid = this.steamIdFromUid(u?.uid ?? '');
        if (!sid) return;

        this.ensureProfile(sid, true)
          .then((p) => (this.steamMe = p))
          .catch(() => {});
      });
  }

  steamIdFromUid(uid: string): string | null {
    if (!uid?.startsWith('steam:')) return null;
    return uid.slice('steam:'.length);
  }

  profileOf(steamId: string): SteamMe | null {
    return this.profileCache.get(steamId) ?? null;
  }

  async ensureProfile(steamId: string, allowRefresh = false): Promise<SteamMe | null> {
    if (!steamId) return null;

    const cached = this.profileCache.get(steamId);
    if (cached) return cached;

    if (this.inflight.has(steamId)) return null;

    try {
      this.inflight.add(steamId);

      const stored = await this.readProfileFromStore(steamId);
      if (stored) {
        this.profileCache.set(steamId, stored);
        return stored;
      }

      if (!allowRefresh) return null;

      const fresh = await this.fetchAndStoreProfile(steamId);
      this.profileCache.set(steamId, fresh);
      return fresh;
    } finally {
      this.inflight.delete(steamId);
    }
  }

  private profileRef(steamId: string) {
    return doc(db, 'steamProfiles', steamId);
  }

  private async readProfileFromStore(steamId: string): Promise<SteamMe | null> {
    const snap = await getDoc(this.profileRef(steamId));
    if (!snap.exists()) return null;
    const data = snap.data() as SteamMe;
    if (!data?.steamId) return null;
    return data;
  }

  private async fetchAndStoreProfile(steamId: string): Promise<SteamMe> {
    const r = await fetch(`/api/steam/me?steamId=${encodeURIComponent(steamId)}`);
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`SteamMe HTTP ${r.status} ${t}`.trim());
    }

    const data = (await r.json()) as SteamMe;
    await setDoc(
      this.profileRef(steamId),
      { ...data, updatedAt: serverTimestamp() },
      { merge: true }
    );
    return data;
  }

  get activeServerConnection(): ServerConnection {
    return this.serverConnection;
  }

  async refreshMyProfile(mySteamId: string | null): Promise<void> {
    if (!mySteamId || this.steamRefreshBusy) return;
    this.steamRefreshBusy = true;
    this.steamRefreshErr = '';

    try {
      const data = await this.fetchAndStoreProfile(mySteamId);
      this.profileCache.set(mySteamId, data);
      this.steamMe = data;
    } catch (err: any) {
      this.steamRefreshErr = err?.message ?? String(err);
    } finally {
      this.steamRefreshBusy = false;
    }
  }

  myStatus(match: MatchDoc | null, mySteamId: string | null): 'fuera' | 'cola' | 'team1' | 'team2' {
    if (!match || !mySteamId) return 'fuera';
    if ((match.team1?.players ?? []).includes(mySteamId)) return 'team1';
    if ((match.team2?.players ?? []).includes(mySteamId)) return 'team2';
    if ((match.queue ?? []).includes(mySteamId)) return 'cola';
    return 'fuera';
  }

  async join(match: MatchDoc | null, mySteamId: string | null) {
    if (!match || !mySteamId) return;
    await this.matchSvc.joinQueue(mySteamId);
  }

  async leave(match: MatchDoc | null, mySteamId: string | null) {
    if (!match || !mySteamId) return;
    await this.matchSvc.leaveQueue(mySteamId);
  }

  toggleWatch() {
    this.watchMatch = !this.watchMatch;
  }

  async logout() {
    await this.auth.logout();
    await this.router.navigateByUrl('/login');
  }
}
