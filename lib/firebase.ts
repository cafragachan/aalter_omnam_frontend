import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app"
import { getAuth, type Auth } from "firebase/auth"
import { getDatabase, type Database } from "firebase/database"
import { getStorage, type FirebaseStorage } from "firebase/storage"

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
}

function getFirebaseApp(): FirebaseApp | null {
  if (!firebaseConfig.apiKey) return null
  return getApps().length ? getApp() : initializeApp(firebaseConfig)
}

const app = getFirebaseApp()

export const auth: Auth | null = app ? getAuth(app) : null
export const database: Database | null = app ? getDatabase(app) : null
export const storage: FirebaseStorage | null = app ? getStorage(app) : null
