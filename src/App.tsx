/**
 * Routing and the persistent shell.
 *
 * Summary:
 *   Three routes: the strategy grid, a strategy write-up, and the Test Strategy workspace. Route
 *   paths come from the registry entries themselves, so a new strategy never needs a new route.
 */

import { Link, Route, Routes, useLocation } from 'react-router-dom'

import { HomePage } from './pages/HomePage'
import { StrategyPage } from './pages/StrategyPage'
import { TestStrategyPage } from './pages/TestStrategyPage'
import { getStrategy } from './strategies/registry'

/**
 * Work out what to show in the header for the current route.
 *
 * Parameters:
 *   pathname: the current location's pathname.
 * Returns:
 *   A breadcrumb label, or null on the home route.
 * Raises:
 *   Nothing.
 * Summary:
 *   Resolves strategy ids to their display names so the header never shows a slug.
 */
function crumbFor(pathname: string): string | null {
  if (pathname === '/') return null
  if (pathname === '/test') return 'Test Strategy'
  const match = /^\/strategy\/(.+)$/.exec(pathname)
  if (match) return getStrategy(match[1])?.name ?? 'Strategy'
  return null
}

/**
 * Render the application.
 *
 * Parameters:
 *   None.
 * Returns:
 *   The root element.
 * Raises:
 *   Nothing.
 * Summary:
 *   The workspace needs the full viewport height, so the shell is a column flexbox and each page
 *   claims the remaining space.
 */
export function App() {
  const { pathname } = useLocation()
  const crumb = crumbFor(pathname)

  return (
    <div className="app-shell">
      <header className="site-header">
        <Link to="/" className="site-header__brand">
          <span className="site-header__mark" aria-hidden="true">
            ⌗
          </span>
          One-Shot Takeoff
        </Link>
        {crumb && (
          <>
            <span className="site-header__crumb" aria-hidden="true">
              /
            </span>
            <span className="site-header__crumb">{crumb}</span>
          </>
        )}
        <span className="site-header__spacer" />
        {pathname !== '/test' && (
          <Link to="/test" className="site-header__link">
            Test Strategy
          </Link>
        )}
        {pathname !== '/' && (
          <Link to="/" className="site-header__link">
            All strategies
          </Link>
        )}
      </header>

      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/strategy/:id" element={<StrategyPage />} />
        <Route path="/test" element={<TestStrategyPage />} />
        <Route path="*" element={<HomePage />} />
      </Routes>
    </div>
  )
}
