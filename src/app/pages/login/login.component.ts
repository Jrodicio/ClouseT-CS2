import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';

@Component({
  standalone: true,
  imports: [CommonModule],
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.css']
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
  
  async loginAnon() {
    this.loading = true;
    this.error = '';
    try {
      await this.auth.loginAnonymous();
      await this.router.navigateByUrl('/dashboard');
    } catch (e: any) {
      this.error = e?.message ?? 'Error en login anónimo';
    } finally {
      this.loading = false;
    }
  }

}
