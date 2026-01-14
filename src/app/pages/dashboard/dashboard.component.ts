import { Component, DestroyRef, inject, NgZone } from '@angular/core';
import { Router } from '@angular/router';
import { AsyncPipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { doc, getDoc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';

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
  private zone = inject(NgZone);

  watchMatch = false;
  readonly serverConnection: ServerConnection = {
    host: '45.235.98.222',
    port: 27159,
    spectatePort: 27159,
    connectUrl: 'steam://connect/45.235.98.222:27159',
    spectateUrl: 'steam://connect/45.235.98.222:27159',
  };

  // Steam cache
  steamErr = '';
  steamRefreshErr = '';
  steamRefreshBusy = false;
  private currentUserSteamId: string | null = null;
  private currentUserUnsubscribe: (() => void) | null = null;
  myProfile: SteamMe | null = null;

  match$ = this.matchSvc.match$;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.currentUserUnsubscribe?.();
      this.currentUserUnsubscribe = null;
    });

    // 1) asegurar doc + realtime
    this.matchSvc.ensureAndSubscribe().catch((e) => console.error('ensureAndSubscribe error', e));

    // 2) Cargar mi perfil auto
    this.auth.user$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((u) => {
        const sid = this.steamIdFromUid(u?.uid ?? '');
        this.setCurrentUserSteamId(sid);
      });
  }

  steamIdFromUid(uid: string): string | null {
    if (!uid?.startsWith('steam:')) return null;
    return uid.slice('steam:'.length);
  }

  private profileRef(steamId: string) {
    return doc(db, 'steamProfiles', steamId);
  }

  private async readProfileFromStore(steamId: string): Promise<SteamMe | null> {
    const snap = await getDoc(this.profileRef(steamId));
    if (!snap.exists()) return null;
    return this.normalizeProfile(steamId, snap.data() as Partial<SteamMe>);
  }

  private normalizeProfile(steamId: string, data: Partial<SteamMe> | null): SteamMe | null {
    if (!data) return null;
    const normalized: SteamMe = {
      steamId: data.steamId ?? steamId,
      personaName: data.personaName ?? '',
      avatar: data.avatar ?? '',
      profileUrl: data.profileUrl ?? '',
    };
    if (!normalized.steamId) return null;
    return normalized;
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

  private setCurrentUserSteamId(steamId: string | null) {
    if (this.currentUserSteamId === steamId) return;

    this.currentUserSteamId = steamId;
    this.currentUserUnsubscribe?.();
    this.currentUserUnsubscribe = null;

    if (!steamId) {
      this.zone.run(() => {
        this.myProfile = null;
      });
      return;
    }

    this.currentUserUnsubscribe = onSnapshot(
      this.profileRef(steamId),
      (snap) => {
        if (!snap.exists()) {
          this.zone.run(() => {
            this.myProfile = null;
          });
          return;
        }
        const data = this.normalizeProfile(steamId, snap.data() as Partial<SteamMe>);
        if (!data) return;
        this.zone.run(() => {
          this.myProfile = data;
          this.steamErr = '';
        });
      },
      (err) => {
        console.error('Steam profile onSnapshot error:', err);
        this.zone.run(() => {
          this.steamErr = err?.message ?? String(err);
        });
      }
    );

    this.ensureProfileOnFirstLogin(steamId).catch((err) => {
      console.error('ensureProfileOnFirstLogin error:', err);
    });
  }

  private async ensureProfileOnFirstLogin(steamId: string): Promise<void> {
    const stored = await this.readProfileFromStore(steamId);
    if (stored) return;
    await this.fetchAndStoreProfile(steamId);
  }

  get activeServerConnection(): ServerConnection {
    return this.serverConnection;
  }

  async refreshMyProfile(mySteamId: string | null): Promise<void> {
    if (!mySteamId || this.steamRefreshBusy) return;
    this.zone.run(() => {
      this.steamRefreshBusy = true;
      this.steamRefreshErr = '';
    });

    try {
      await this.fetchAndStoreProfile(mySteamId);
    } catch (err: any) {
      this.zone.run(() => {
        this.steamRefreshErr = err?.message ?? String(err);
      });
    } finally {
      this.zone.run(() => {
        this.steamRefreshBusy = false;
      });
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
