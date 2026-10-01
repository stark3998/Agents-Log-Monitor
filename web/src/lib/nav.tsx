import type { ReactElement } from 'react';
import SpaceDashboardRoundedIcon from '@mui/icons-material/SpaceDashboardRounded';
import ForumRoundedIcon from '@mui/icons-material/ForumRounded';
import GppMaybeRoundedIcon from '@mui/icons-material/GppMaybeRounded';
import ReportRoundedIcon from '@mui/icons-material/ReportRounded';
import AccountBalanceRoundedIcon from '@mui/icons-material/AccountBalanceRounded';
import FactCheckRoundedIcon from '@mui/icons-material/FactCheckRounded';
import PolicyRoundedIcon from '@mui/icons-material/PolicyRounded';
import AltRouteRoundedIcon from '@mui/icons-material/AltRouteRounded';
import SmartToyRoundedIcon from '@mui/icons-material/SmartToyRounded';
import RadarRoundedIcon from '@mui/icons-material/RadarRounded';
import HealthAndSafetyRoundedIcon from '@mui/icons-material/HealthAndSafetyRounded';
import CompareArrowsRoundedIcon from '@mui/icons-material/CompareArrowsRounded';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import MenuBookRoundedIcon from '@mui/icons-material/MenuBookRounded';

export interface NavItem {
  path: string;
  label: string;
  icon: ReactElement;
  /** What the page shows. */
  description: string;
  /** Why you'd open it. */
  purpose: string;
  /** Only shown when the governance plane is enabled. */
  gov?: boolean;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Monitor',
    items: [
      {
        path: '/overview', label: 'Overview', icon: <SpaceDashboardRoundedIcon />,
        description: 'Headline activity across every monitored agent: KPIs with trends, top agents, and the MCP servers and domains they reached.',
        purpose: 'Start here to spot changes, then open the conversations behind any number.',
      },
      {
        path: '/conversations', label: 'Conversations', icon: <ForumRoundedIcon />,
        description: 'Every captured agent session with its agent, endpoint, user, severity, detected data and enforcement outcome.',
        purpose: 'Filter down to the sessions that matter and read the full timeline of prompts, tool calls and findings.',
      },
      {
        path: '/enforcements', label: 'Enforcements', icon: <GppMaybeRoundedIcon />,
        description: 'Tool calls allowed or denied by the policy engine, plus policy events the agents reported themselves.',
        purpose: 'Audit what was blocked, warned or allowed, and which rule made the call.',
      },
      {
        path: '/incidents', label: 'Incidents', gov: true, icon: <ReportRoundedIcon />,
        description: 'Incidents raised by the governance plane, the Guardian investigator and the monitoring fleet, with reports and recommendations.',
        purpose: 'Triage open incidents, review the evidence and decide on containment.',
      },
    ],
  },
  {
    title: 'Govern',
    items: [
      {
        path: '/governance', label: 'Governance', gov: true, icon: <AccountBalanceRoundedIcon />,
        description: 'Policy decisions over time (allowed, denied and would-deny in observe mode), recent denies and requests waiting for approval.',
        purpose: 'Check the health of inline enforcement at a glance.',
      },
      {
        path: '/approvals', label: 'Approvals', gov: true, icon: <FactCheckRoundedIcon />,
        description: 'Agent actions waiting for a human decision, soonest to expire first, and recently resolved requests.',
        purpose: 'Approve or deny escalated actions before they time out.',
      },
      {
        path: '/policies', label: 'Policies', gov: true, icon: <PolicyRoundedIcon />,
        description: 'Reusable governance policies, sensitive-data classifiers and preset condition catalogs.',
        purpose: 'Author, review and activate the rules that lanes enforce.',
      },
      {
        path: '/lanes', label: 'Lanes', gov: true, icon: <AltRouteRoundedIcon />,
        description: 'Each agent’s mandate as code: its purpose, what it should and must never do, deterministic rules, and when to ask the LLM judge or a human.',
        purpose: 'Define what an agent may do and roll changes out safely with diffs and simulation against history.',
      },
      {
        path: '/agents', label: 'Agents', gov: true, icon: <SmartToyRoundedIcon />,
        description: 'Registry of every agent the enforcement points have seen, with its surface, owner, lane, status and decision counts.',
        purpose: 'Pause, resume or quarantine an agent when it misbehaves.',
      },
    ],
  },
  {
    title: 'Fleet & posture',
    items: [
      {
        path: '/fleet', label: 'Fleet', gov: true, icon: <RadarRoundedIcon />,
        description: 'Alerts from the monitoring fleet about Foundry and Copilot Studio agents and direct model callers, mapped to OWASP LLM, OWASP Agentic and MITRE ATLAS.',
        purpose: 'Investigate threats to hosted agents by severity, type, platform and agent.',
      },
      {
        path: '/posture', label: 'Posture', gov: true, icon: <HealthAndSafetyRoundedIcon />,
        description: 'Security hygiene of the endpoints that run agent tooling: findings, check configuration and endpoint inventory.',
        purpose: 'Find risky local configuration and fix it, automatically where possible.',
      },
      {
        path: '/jev', label: 'Jev vs LLM', gov: true, icon: <CompareArrowsRoundedIcon />,
        description: 'TypeSafe Jev compared with the LLM judge, Prompt Shields, Guardian and heuristic severity, offline and in live shadow mode.',
        purpose: 'Decide whether Jev is accurate, fast and cheap enough to take over decisions.',
      },
    ],
  },
  {
    title: 'Help',
    items: [
      {
        path: '/ask', label: 'Ask', gov: true, icon: <AutoAwesomeRoundedIcon />,
        description: 'A chat assistant grounded in the project documentation, running on Microsoft Foundry.',
        purpose: 'Get answers with citations that link straight to the relevant docs.',
      },
      {
        path: '/docs', label: 'Docs', icon: <MenuBookRoundedIcon />,
        description: 'Every Markdown document in the repository, organised by section, searchable and cross-linked.',
        purpose: 'Learn how the monitor, governance plane and fleet work, and how to deploy them.',
      },
    ],
  },
];

/** Sections with the items visible for the current mode (governance pages only when it's enabled). */
export function visibleSections(governance: boolean): NavSection[] {
  return NAV_SECTIONS
    .map(s => ({ ...s, items: s.items.filter(i => !i.gov || governance) }))
    .filter(s => s.items.length > 0);
}

/** The nav entry (and its section) that owns a route, e.g. `/policies/p-1` → Policies. */
export function findNavItem(pathname: string): { item: NavItem; section: NavSection } | undefined {
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (pathname === item.path || pathname.startsWith(`${item.path}/`)) return { item, section };
    }
  }
  return undefined;
}
