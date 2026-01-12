import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';

@Component({
  standalone: true,
  imports: [CommonModule],
  template: `
    <div style="max-width:420px;margin:40px auto;font-family:system-ui;">
      <h1>Login</h1>
      <p>Entrá con Steam para acceder al dashboard.</p>

      <button (click)="loginSteam()" style="padding:10px 14px;cursor:pointer;">
        Login con Steam
      </button>

      <!-- <button (click)="loginAnon()" style="padding:10px 14px;cursor:pointer; margin-left: 8px;">
        Login anónimo (test)
      </button> -->


      @if (loading) {
        <p style="margin-top:12px;">Procesando...</p>
      }

      @if (error) {
        <p style="color:#b00020;margin-top:12px;">{{ error }}</p>
      }
    </div>
  `,
})

export class LoginComponent implements OnInit {
  private auth = inject(AuthService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  loading = false;
  error = '';

  async ngOnInit() {
    // Si volvemos desde el backend con token de Firebase:
    const token = this.route.snapshot.queryParamMap.get('token');
    const err = this.route.snapshot.queryParamMap.get('error');
    if (err) this.error = err;

    if (token) {
      this.loading = true;
      try {
        await this.auth.loginWithCustomToken(token);
        await this.router.navigateByUrl('/dashboard');
      } catch (e: any) {
        this.error = e?.message ?? 'Error al iniciar sesión';
      } finally {
        this.loading = false;
      }
    }
  }

  loginSteam() {
    const redirect = `${window.location.origin}/login`;
    const url = `/api/auth/steam/start?redirect=${encodeURIComponent(redirect)}`;
    window.location.href = url;
  }
  
  

  // async loginAnon() {
  //   this.loading = true;
  //   this.error = '';
  //   try {
  //     await this.auth.loginAnonymous();
  //     await this.router.navigateByUrl('/dashboard');
  //   } catch (e: any) {
  //     this.error = e?.message ?? 'Error en login anónimo';
  //   } finally {
  //     this.loading = false;
  //   }
  // }

}
