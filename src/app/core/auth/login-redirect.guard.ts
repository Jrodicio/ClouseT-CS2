import { CanActivateFn, Router } from '@angular/router';
import { inject } from '@angular/core';
import { AuthService } from './auth.service';

export const loginRedirectGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const logged = await auth.isLoggedInOnce();
  if (logged) {
    router.navigateByUrl('/dashboard');
    return false;
  }
  return true;
};
