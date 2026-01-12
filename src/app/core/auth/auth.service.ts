import { Injectable } from '@angular/core';
import {
  User,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  signInWithCustomToken,
  signOut,
} from 'firebase/auth';
import { Observable } from 'rxjs';
import { auth } from '../firebase/firebase';
// import { signInAnonymously } from 'firebase/auth';

@Injectable({ providedIn: 'root' })
export class AuthService {
  user$ = new Observable<User | null>((subscriber) => {
    const unsub = onAuthStateChanged(
      auth,
      (user) => subscriber.next(user),
      (err) => subscriber.error(err)
    );
    return () => unsub();
  });

  async ensurePersistence(): Promise<void> {
    // Sesión persistente en el navegador
    await setPersistence(auth, browserLocalPersistence);
  }

  async getUserOnce(): Promise<User | null> {
    return await new Promise((resolve) => {
      const unsub = onAuthStateChanged(auth, (user) => {
        unsub();
        resolve(user ?? null);
      });
    });
  }

  async isLoggedInOnce(): Promise<boolean> {
    return !!(await this.getUserOnce());
  }

  async loginWithCustomToken(token: string): Promise<User> {
    await this.ensurePersistence();
    const cred = await signInWithCustomToken(auth, token);
    return cred.user;
  }

  async logout(): Promise<void> {
    await signOut(auth);
  }

  // async loginAnonymous(): Promise<User> {
  //   await this.ensurePersistence();
  //   const cred = await signInAnonymously(auth);
  //   return cred.user;
  // }

}
