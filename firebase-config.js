// JR INVENT - Configuração Firebase com Persistência Offline e Autenticação Anônima
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { 
  initializeFirestore, 
  persistentLocalCache, 
  persistentMultipleTabManager,
  getFirestore
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

// Chaves de configuração do seu projeto Firebase Console
// NOTA: No modelo de segurança do Firestore com regras, essas chaves identificam o projeto e não precisam ser secretas.
export const firebaseConfig = window.__FIREBASE_CONFIG__ || {
  apiKey: "AIzaSyACZesYiq1rzPjJjMJsgBBrRdip2sMT9Hk",
  authDomain: "jr-invent.firebaseapp.com",
  projectId: "jr-invent",
  storageBucket: "jr-invent.firebasestorage.app",
  messagingSenderId: "1035696742736",
  appId: "1:1035696742736:web:76040c87d182b5d9340c55"
};

let appInstance;
if (!getApps().length) {
  appInstance = initializeApp(firebaseConfig);
} else {
  appInstance = getApps()[0];
}

export const app = appInstance;

// Ativa cache + fila de escrita offline nativos do Firestore.
// persistentMultipleTabManager evita conflito se o PWA ficar aberto em duas abas no mesmo aparelho.
let firestoreInstance;
try {
  firestoreInstance = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  });
} catch (e) {
  // Fallback caso já esteja inicializado
  firestoreInstance = getFirestore(app);
}

export const db = firestoreInstance;
export const auth = getAuth(app);

let authPromise = null;
export async function ensureAuth() {
  if (auth.currentUser) return auth.currentUser;
  if (!authPromise) {
    authPromise = signInAnonymously(auth)
      .then((cred) => cred.user)
      .catch((err) => {
        authPromise = null;
        console.warn("Aviso na autenticação anônima do Firebase (verifique se 'Anônimo' está ativo no Firebase Console):", err);
        return null;
      });
  }
  return authPromise;
}

// Autenticação anônima em segundo plano para atender request.auth != null nas regras de segurança
ensureAuth().catch(() => {});

