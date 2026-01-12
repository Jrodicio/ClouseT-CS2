import { Component, Input, inject } from '@angular/core';
import { MatchDoc } from '../../core/match/match.service';
import { MatchService } from '../../core/match/match.service';

type SteamMe = {
  steamId: string;
  personaName: string;
  avatar: string;
  profileUrl: string;
};

@Component({
  standalone: true,
  selector: 'app-match-board',
  templateUrl: './match-board.component.html',
  styleUrl: './match-board.component.css',
})
export class MatchBoardComponent {
  private matchSvc = inject(MatchService);

  @Input({ required: true }) match!: MatchDoc;
  @Input({ required: true }) showDetails = true;

  // función que viene del Dashboard (cache)
  @Input({ required: true }) profileOf!: (steamId: string) => SteamMe | null;

  // steamId del usuario logueado (para habilitar pick)
  @Input() mySteamId: string | null = null;

  // opcional (si lo pasás desde dashboard)
  @Input() leaderA: string | null = null;
  @Input() leaderB: string | null = null;

  // UI state local
  selectedId: string | null = null;
  busyPick = false;
  pickErr = '';

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

  /** Lista de disponibles en el centro */
  get availableIds(): string[] {
    const list = this.unassigned.length ? this.unassigned : this.queue;
    // no mostrar líderes ahí por las dudas
    const la = this.leaderAId;
    const lb = this.leaderBId;
    return list.filter((x) => x && x !== la && x !== lb);
  }

  titleFor(id: string): string {
    const p = this.profileOf?.(id);
    return p?.personaName ?? id;
  }

  onSelect(id: string): void {
    if (!id) return;
    if (this.match?.estado !== 'armando_equipos') return;
    // UI: cualquiera puede seleccionar para mirar, pero el pick solo lo puede ejecutar el líder
    this.selectedId = this.selectedId === id ? null : id;
    this.pickErr = '';
  }

  async onPick(): Promise<void> {
    if (!this.canPick) return;
    if (!this.selectedId) return;

    try {
      this.busyPick = true;
      this.pickErr = '';

      await this.matchSvc.pickPlayer(this.mySteamId!, this.selectedId);

      // reset selección si salió bien
      this.selectedId = null;
    } catch (e: any) {
      this.pickErr = e?.message ?? String(e);
    } finally {
      this.busyPick = false;
    }
  }
}
