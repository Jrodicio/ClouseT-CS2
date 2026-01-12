import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

export const firebaseConfig = {
    apiKey: "AIzaSyD1m1RhdiM9NtlEv9-lk-TT9bQhBUvC2d0",
    authDomain: "clouset-cs2.firebaseapp.com",
    projectId: "clouset-cs2",
    storageBucket: "clouset-cs2.firebasestorage.app",
    messagingSenderId: "129931894882",
    appId: "1:129931894882:web:a45936fa981264e8ee713b"
  };

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);