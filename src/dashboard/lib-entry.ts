/**
 * Public entry for `watchdeck/dashboard` — the mountable dashboard component
 * users import into their own React app.
 *
 * The CSS import here is a side-effect pull only: it tells Vite's lib build
 * to collect every Tailwind/HeroUI rule reachable from the component tree
 * into `dist/dashboard-mount/styles.css`. Consumers import that sibling file
 * once at their layout level — see `watchdeck/dashboard/styles.css` exposed
 * via the package's `exports` map.
 */
import './globals.css'

export {
  WatchDeckDashboard,
  type WatchDeckDashboardProps,
} from './WatchDeckDashboard'
export { default } from './WatchDeckDashboard'
