"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth"
import { ref, set, get } from "firebase/database"
import { auth, database } from "@/lib/firebase"
import { loadReturningUser } from "@/lib/firebase/user-profile-service"
import type { ReturningUserData } from "@/lib/firebase/types"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserDBProfile {
  firstName: string
  lastName: string
  email: string
  phoneNumber: string
  dateOfBirth: string
  nationality: string
  languagePreference: string
  createdAt: string
  lastSeenAt: string
}

interface AuthContextValue {
  /** Firebase user object (null when signed out) */
  firebaseUser: User | null
  /** User profile from Realtime Database */
  userProfile: UserDBProfile | null
  /** Returning user personality + preferences (loaded on login) */
  returningUserData: ReturningUserData | null
  /** True once onAuthStateChanged has fired at least once */
  isAuthReady: boolean
  /** Convenience: firebaseUser !== null */
  isAuthenticated: boolean
  /** Sign in with email + password. Throws on error. */
  login: (email: string, password: string) => Promise<UserDBProfile>
  /** Create account + write profile to Realtime DB. Throws on error. */
  register: (data: RegisterData) => Promise<UserDBProfile>
  /** Sign out of Firebase. */
  logout: () => Promise<void>
}

export interface RegisterData {
  email: string
  password: string
  firstName: string
  lastName: string
  phoneNumber: string
  dateOfBirth: string
  nationality: string
  languagePreference: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch user profile from Realtime Database */
async function fetchUserProfile(uid: string): Promise<UserDBProfile | null> {
  if (!database) return null
  const snapshot = await get(ref(database, `omnam/users/${uid}/identity`))
  if (!snapshot.exists()) return null
  return snapshot.val() as UserDBProfile
}

/** Write a new user profile to Realtime Database */
async function writeUserProfile(uid: string, data: RegisterData): Promise<UserDBProfile> {
  if (!database) throw new Error("Firebase database not configured")
  const now = new Date().toISOString()
  const profile: UserDBProfile = {
    firstName: data.firstName.trim(),
    lastName: data.lastName.trim(),
    email: data.email.toLowerCase().trim(),
    phoneNumber: data.phoneNumber.trim(),
    dateOfBirth: data.dateOfBirth,
    nationality: data.nationality.trim(),
    languagePreference: data.languagePreference.trim() || "en",
    createdAt: now,
    lastSeenAt: now,
  }
  await set(ref(database, `omnam/users/${uid}/identity`), profile)
  return profile
}

/** Update lastSeenAt timestamp */
async function updateLastSeen(uid: string): Promise<void> {
  if (!database) return
  await set(ref(database, `omnam/users/${uid}/identity/lastSeenAt`), new Date().toISOString())
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null)
  const [userProfile, setUserProfile] = useState<UserDBProfile | null>(null)
  const [returningUserData, setReturningUserData] = useState<ReturningUserData | null>(null)
  const [isAuthReady, setIsAuthReady] = useState(false)

  // Listen to Firebase auth state
  useEffect(() => {
    if (!auth) {
      setIsAuthReady(true)
      return
    }
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user)
      if (user) {
        const profile = await fetchUserProfile(user.uid)
        setUserProfile(profile)
        if (profile) {
          await updateLastSeen(user.uid)
          // Load returning user personality + preferences
          try {
            const returning = await loadReturningUser(user.uid)
            setReturningUserData(returning)
          } catch {
            // Non-critical — proceed without returning data
          }
        }
      } else {
        setUserProfile(null)
        setReturningUserData(null)
      }
      setIsAuthReady(true)
    })
    return unsubscribe
  }, [])

  const login = useCallback(async (email: string, password: string): Promise<UserDBProfile> => {
    if (!auth) throw new Error("Firebase auth not configured")
    const credential = await signInWithEmailAndPassword(auth, email.trim(), password)
    const profile = await fetchUserProfile(credential.user.uid)
    if (profile) {
      await updateLastSeen(credential.user.uid)
      try {
        const returning = await loadReturningUser(credential.user.uid)
        setReturningUserData(returning)
      } catch {
        // Non-critical
      }
    }
    setUserProfile(profile)
    return profile!
  }, [])

  const register = useCallback(async (data: RegisterData): Promise<UserDBProfile> => {
    if (!auth) throw new Error("Firebase auth not configured")
    const credential = await createUserWithEmailAndPassword(auth, data.email.trim(), data.password)
    const profile = await writeUserProfile(credential.user.uid, data)
    setUserProfile(profile)
    return profile
  }, [])

  const logout = useCallback(async () => {
    if (!auth) return
    await signOut(auth)
    setUserProfile(null)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      firebaseUser,
      userProfile,
      returningUserData,
      isAuthReady,
      isAuthenticated: firebaseUser !== null,
      login,
      register,
      logout,
    }),
    [firebaseUser, userProfile, returningUserData, isAuthReady, login, register, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider")
  }
  return context
}
