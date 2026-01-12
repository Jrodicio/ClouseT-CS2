import { Routes } from '@angular/router';
import { LoginComponent } from './pages/login/login.component';
import { DashboardComponent } from './pages/dashboard/dashboard.component';
import { authGuard } from './core/auth/auth.guard';
import { loginRedirectGuard } from './core/auth/login-redirect.guard';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },

  // Si ya estás logueado, no te dejo entrar a /login
  { path: 'login', component: LoginComponent, canActivate: [loginRedirectGuard] },

  // Protegida: si no estás logueado → /login
  { path: 'dashboard', component: DashboardComponent, canActivate: [authGuard] },

  { path: '**', redirectTo: 'dashboard' },
];
