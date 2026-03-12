import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import type { WhitelistedUser } from "@shared/schema";

interface UserContextValue {
  currentUser: WhitelistedUser | null;
  setCurrentUser: (user: WhitelistedUser | null) => void;
  isAdmin: boolean;
  canAddKB: boolean;
  logout: () => void;
}

const UserContext = createContext<UserContextValue>({
  currentUser: null,
  setCurrentUser: () => {},
  isAdmin: false,
  canAddKB: false,
  logout: () => {},
});

const STORAGE_KEY = "support_ai_user";

export function UserProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUserState] = useState<WhitelistedUser | null>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  const setCurrentUser = (user: WhitelistedUser | null) => {
    setCurrentUserState(user);
    if (user) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  };

  const logout = () => setCurrentUser(null);

  return (
    <UserContext.Provider value={{
      currentUser,
      setCurrentUser,
      isAdmin: currentUser?.role === "admin",
      canAddKB: currentUser?.canAddKB === true || currentUser?.role === "admin",
      logout,
    }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  return useContext(UserContext);
}

// Returns headers object with user email for authenticated requests
export function useAuthHeaders(): Record<string, string> {
  const { currentUser } = useUser();
  return currentUser ? { "x-user-email": currentUser.email } : {};
}
