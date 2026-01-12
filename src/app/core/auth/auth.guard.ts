import { CanActivateFn, Router } from '@angular/router';
import { inject } from '@angular/core';
import { AuthService } from './auth.service';

export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const logged = await auth.isLoggedInOnce();
  if (!logged) {
    router.navigateByUrl('/login');
    return false;
  }
  return true;
};
