import { useTheme as useNextTheme } from 'next-themes'

/**
 * Theme hook — wraps next-themes for light/dark toggle.
 * Uses system preference as default, persists choice in localStorage.
 */
export function useTheme() {
  const { theme, setTheme, resolvedTheme } = useNextTheme()

  const toggleTheme = () => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
  }

  return {
    theme: resolvedTheme ?? 'light',
    setTheme,
    toggleTheme,
    isDark: resolvedTheme === 'dark',
  }
}
