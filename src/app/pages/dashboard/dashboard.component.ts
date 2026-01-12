import { Component, DestroyRef, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AsyncPipe, NgStyle } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { AuthService } from '../../core/auth/auth.service';
import { MatchService, MatchDoc } from '../../core/match/match.service';
import { MatchBoardComponent } from './match-board.component';

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
  imports: [AsyncPipe, NgStyle, MatchBoardComponent],
  templateUrl: './dashboard.component.html',
})
export class DashboardComponent {
  auth = inject(AuthService);
  matchSvc = inject(MatchService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  watchMatch = false;
  serverConnection: ServerConnection | null = null;
  serverConnectionError = '';

  // Steam cache
  steamMe: SteamMe | null = null;
  steamErr = '';
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

        this.ensureProfile(sid)
          .then((p) => (this.steamMe = p))
          .catch(() => {});
      });

    this.loadServerConnection().catch((e) =>
      console.error('loadServerConnection error', e)
    );
  }

  steamIdFromUid(uid: string): string | null {
    if (!uid?.startsWith('steam:')) return null;
    return uid.slice('steam:'.length);
  }

  profileOf(steamId: string): SteamMe | null {
    return this.profileCache.get(steamId) ?? null;
  }

  async ensureProfile(steamId: string): Promise<SteamMe | null> {
    if (!steamId) return null;

    const cached = this.profileCache.get(steamId);
    if (cached) return cached;

    if (this.inflight.has(steamId)) return null;

    try {
      this.inflight.add(steamId);

      const r = await fetch(`/api/steam/me?steamId=${encodeURIComponent(steamId)}`);
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`SteamMe HTTP ${r.status} ${t}`.trim());
      }

      const data = (await r.json()) as SteamMe;
      this.profileCache.set(steamId, data);
      return data;
    } finally {
      this.inflight.delete(steamId);
    }
  }

  async loadServerConnection(): Promise<void> {
    try {
      const r = await fetch('/api/server/connection');
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        this.serverConnectionError = `No se pudo obtener el servidor (${r.status}) ${t}`.trim();
        return;
      }

      this.serverConnection = (await r.json()) as ServerConnection;
      this.serverConnectionError = '';
    } catch (err: any) {
      this.serverConnectionError = err?.message ?? String(err);
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
