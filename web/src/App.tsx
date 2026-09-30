import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Skeleton, Stack } from '@mui/material';
import { AppShell } from './components/AppShell';
import { OverviewPage } from './pages/overview/OverviewPage';
import { ConversationsPage } from './pages/conversations/ConversationsPage';
import { ConversationPage } from './pages/conversation/ConversationPage';
import { EnforcementsPage } from './pages/enforcements/EnforcementsPage';

// Governance pages are code-split: they only load when visited.
const GovernanceOverviewPage = lazy(() => import('./pages/governance/GovernanceOverviewPage').then(m => ({ default: m.GovernanceOverviewPage })));
const ApprovalsPage = lazy(() => import('./pages/approvals/ApprovalsPage').then(m => ({ default: m.ApprovalsPage })));
const AgentsPage = lazy(() => import('./pages/agents/AgentsPage').then(m => ({ default: m.AgentsPage })));
const LanesPage = lazy(() => import('./pages/lanes/LanesPage').then(m => ({ default: m.LanesPage })));
const LaneEditorPage = lazy(() => import('./pages/lanes/LaneEditorPage').then(m => ({ default: m.LaneEditorPage })));
const PoliciesPage = lazy(() => import('./pages/policies/PoliciesPage').then(m => ({ default: m.PoliciesPage })));
const PolicyEditorPage = lazy(() => import('./pages/policies/PolicyEditorPage').then(m => ({ default: m.PolicyEditorPage })));
const PosturePage = lazy(() => import('./pages/posture/PosturePage').then(m => ({ default: m.PosturePage })));
const IncidentsPage = lazy(() => import('./pages/incidents/IncidentsPage').then(m => ({ default: m.IncidentsPage })));
const IncidentDetailPage = lazy(() => import('./pages/incidents/IncidentDetailPage').then(m => ({ default: m.IncidentDetailPage })));
const AskPage = lazy(() => import('./pages/ask/AskPage').then(m => ({ default: m.AskPage })));
const JevComparisonPage = lazy(() => import('./pages/jev/JevComparisonPage').then(m => ({ default: m.JevComparisonPage })));
const FleetPage = lazy(() => import('./pages/fleet/FleetPage').then(m => ({ default: m.FleetPage })));
const DocsPage = lazy(() => import('./pages/docs/DocsPage').then(m => ({ default: m.DocsPage })));

function RedirectHome() {
  const { search } = useLocation();
  return <Navigate to={`/overview${search}`} replace />;
}

function PageFallback() {
  return (
    <Stack spacing={2} aria-busy="true" aria-label="Loading page">
      <Skeleton width={260} height={36} />
      <Skeleton variant="rounded" height={120} />
      <Skeleton variant="rounded" height={320} />
    </Stack>
  );
}

const lazyPage = (node: ReactNode) => <Suspense fallback={<PageFallback />}>{node}</Suspense>;

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/overview" element={<OverviewPage />} />
        <Route path="/conversations" element={<ConversationsPage />} />
        <Route path="/conversations/:id" element={<ConversationPage />} />
        <Route path="/enforcements" element={<EnforcementsPage />} />
        <Route path="/governance" element={lazyPage(<GovernanceOverviewPage />)} />
        <Route path="/approvals" element={lazyPage(<ApprovalsPage />)} />
        <Route path="/agents" element={lazyPage(<AgentsPage />)} />
        <Route path="/lanes" element={lazyPage(<LanesPage />)} />
        <Route path="/lanes/:id" element={lazyPage(<LaneEditorPage />)} />
        <Route path="/policies" element={lazyPage(<PoliciesPage />)} />
        <Route path="/policies/:id" element={lazyPage(<PolicyEditorPage />)} />
        <Route path="/posture" element={lazyPage(<PosturePage />)} />
        <Route path="/incidents" element={lazyPage(<IncidentsPage />)} />
        <Route path="/incidents/:id" element={lazyPage(<IncidentDetailPage />)} />
        <Route path="/fleet" element={lazyPage(<FleetPage />)} />
        <Route path="/jev" element={lazyPage(<JevComparisonPage />)} />
        <Route path="/ask" element={lazyPage(<AskPage />)} />
        <Route path="/docs/*" element={lazyPage(<DocsPage />)} />
        <Route path="*" element={<RedirectHome />} />
      </Routes>
    </AppShell>
  );
}
