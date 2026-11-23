import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DescriptionIcon from '@mui/icons-material/DescriptionOutlined';
import HistoryIcon from '@mui/icons-material/HistoryEduOutlined';
import KeyIcon from '@mui/icons-material/KeyOutlined';
import LogoutIcon from '@mui/icons-material/Logout';
import MenuIcon from '@mui/icons-material/Menu';
import MonitorIcon from '@mui/icons-material/MonitorHeartOutlined';
import InboxIcon from '@mui/icons-material/MoveToInboxOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PeopleIcon from '@mui/icons-material/PeopleOutline';
import SettingsIcon from '@mui/icons-material/SettingsOutlined';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import {
  AppBar,
  Avatar,
  Badge,
  Box,
  Button,
  Chip,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';

import { useAuth } from '../auth/AuthContext';
import { ChangePasswordDialog } from '../auth/ChangePasswordDialog';
import { hasPermission, type Permission } from '../auth/permissions';
import { POLL_MS } from '../constants';
import { settingsKeys, systemKeys } from '../features/settings';
import { submissionKeys } from '../features/submissions';
import { useBackNavigation } from '../lib/navigation';
import { safeWebUrl } from '../lib/safeUrl';
import { humanize } from '../lib/status';
import { paths } from '../paths';
import { apiWith } from '../services/api';
import { ConfirmDialog } from './common';
import { ErrorBoundary } from './ErrorBoundary';
import { NotificationBell } from './notifications/NotificationBell';

const DRAWER_WIDTH = 220;

const NAV = [
  { to: '/', label: 'Inbox', icon: <InboxIcon />, match: (p: string) => p === '/' || p.startsWith('/submissions') },
  {
    to: '/settings',
    label: 'Settings',
    icon: <SettingsIcon />,
    match: (p: string) => p.startsWith('/settings') && !p.startsWith('/settings/users'),
  },
];
// Monitoring and the global audit trail show raw errors, applicant names and recipients: admins only (the API agrees).
/** Shown only to users whose role grants the item's permission. */
const ADMIN_NAV: {
  to: string;
  label: string;
  icon: JSX.Element;
  match: (p: string) => boolean;
  permission: Permission;
}[] = [
  {
    to: '/monitoring',
    label: 'Monitoring',
    icon: <MonitorIcon />,
    match: (p: string) => p.startsWith('/monitoring'),
    permission: 'monitoring:view',
  },
  {
    to: '/audit',
    label: 'Audit Trail',
    icon: <HistoryIcon />,
    match: (p: string) => p.startsWith('/audit'),
    permission: 'audit:view',
  },
  {
    to: '/settings/users',
    label: 'Users',
    icon: <PeopleIcon />,
    match: (p: string) => p.startsWith('/settings/users'),
    permission: 'user:manage',
  },
];

/** The page content's id: the skip link's target, and where focus goes when there is no page title. */
const MAIN_ID = 'main';

/** First thing a keyboard user tabs to: jumps past the app bar and the navigation to the page. */
function SkipLink() {
  return (
    <Box
      component="a"
      href={`#${MAIN_ID}`}
      sx={{
        position: 'absolute',
        left: 8,
        top: -48,
        zIndex: (t) => t.zIndex.tooltip + 1,
        px: 2,
        py: 1,
        borderRadius: 1,
        bgcolor: 'background.paper',
        color: 'primary.main',
        fontWeight: 600,
        boxShadow: 3,
        textDecoration: 'none',
        '&:focus': { top: 8 },
      }}
    >
      Skip to main content
    </Box>
  );
}

/**
 * After a client-side navigation, focus moves to the new page's title (or the main region), so screen readers
 * announce the page and the next Tab starts inside it instead of in the sidebar. Not on the first render: the browser
 * already starts at the top.
 */
function useFocusOnNavigation(pathname: string) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // The page may still be loading its chunk: wait a frame for its title.
    const id = requestAnimationFrame(() => {
      const target =
        document.querySelector<HTMLElement>(`#${MAIN_ID} [data-page-title]`) ?? document.getElementById(MAIN_ID);
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [pathname]);
}

export function Layout() {
  const theme = useTheme();
  const permanent = useMediaQuery(theme.breakpoints.up('md'));
  const [mobileOpen, setMobileOpen] = useState(false);
  const [menuEl, setMenuEl] = useState<HTMLElement | null>(null);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const back = useBackNavigation();
  useFocusOnNavigation(pathname);
  const system = useQuery({
    queryKey: systemKeys.status(),
    queryFn: ({ signal }) => apiWith(signal).systemStatus(),
    enabled: !!user,
    refetchInterval: POLL_MS.systemStatus,
  });
  // Matches the inbox poll so newly ingested Gmail messages show up in the badge as they land.
  const unread =
    useQuery({
      queryKey: submissionKeys.unreadCount(),
      queryFn: ({ signal }) => apiWith(signal).unreadCount(),
      enabled: !!user,
      refetchInterval: POLL_MS.unreadCount,
    }).data?.unread ?? 0;
  // Settings → IMS 2 intake → IMS URL: the top bar's IMS button opens it in a new tab; no button while it is unset.
  const imsUrl = safeWebUrl(
    useQuery({
      queryKey: settingsKeys.ims2Queue(),
      queryFn: ({ signal }) => apiWith(signal).ims2QueueSettings(),
      enabled: !!user,
    }).data?.imsUrl,
  );
  const down = system.data?.services.filter((s) => !s.ok) ?? [];
  // Green only when every dependency answered; an unreachable backend counts as offline.
  const online = !system.isError && !!system.data && down.length === 0;
  const dotColor = !system.data && !system.isError ? 'grey.400' : online ? 'success.main' : 'error.main';
  const dotTitle = system.isError
    ? 'Server unreachable'
    : !system.data
      ? 'Checking connections…'
      : online
        ? 'All systems connected'
        : `${down.length} service${down.length > 1 ? 's' : ''} down`;

  const drawer = (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: 'nav.bg', color: 'nav.text' }}>
      <Stack direction="row" spacing={1.25} alignItems="center" sx={{ px: 2, height: 56 }}>
        <ShieldOutlinedIcon sx={{ color: 'nav.icon' }} />
        <Box>
          <Typography variant="subtitle2" sx={{ color: 'common.white', lineHeight: 1.2 }}>
            Submission Intake
          </Typography>
          <Typography variant="caption" sx={{ color: 'nav.muted', fontSize: '0.68rem' }}>
            Med-Mal Underwriting
          </Typography>
        </Box>
      </Stack>
      <Divider sx={{ borderColor: 'nav.divider' }} />
      <List sx={{ px: 1, py: 1.5 }}>
        {[...NAV, ...ADMIN_NAV.filter((n) => hasPermission(user, n.permission))].map((n) => {
          const active = n.match(pathname);
          return (
            <ListItemButton
              key={n.to}
              component={NavLink}
              to={n.to}
              onClick={() => setMobileOpen(false)}
              sx={{
                borderRadius: 1,
                mb: 0.5,
                color: active ? 'common.white' : 'nav.link',
                bgcolor: active ? 'nav.active' : 'transparent',
                '&:hover': { bgcolor: 'nav.hover' },
              }}
            >
              <ListItemIcon sx={{ minWidth: 36, color: 'inherit' }}>{n.icon}</ListItemIcon>
              <ListItemText
                primary={n.label}
                primaryTypographyProps={{ fontSize: '0.85rem', fontWeight: active ? 600 : 500 }}
              />
              {n.to === '/' && unread > 0 && (
                <Badge
                  badgeContent={unread}
                  max={99}
                  color="error"
                  aria-label={`${unread} unread`}
                  sx={{ mr: 1.5, '& .MuiBadge-badge': { position: 'static', transform: 'none', fontWeight: 600 } }}
                />
              )}
            </ListItemButton>
          );
        })}
      </List>
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <SkipLink />
      <AppBar
        position="fixed"
        color="inherit"
        sx={{
          borderBottom: 1,
          borderColor: 'divider',
          width: { md: `calc(100% - ${DRAWER_WIDTH}px)` },
          ml: { md: `${DRAWER_WIDTH}px` },
        }}
      >
        <Toolbar variant="dense" sx={{ minHeight: 56 }}>
          {!permanent && (
            <IconButton edge="start" onClick={() => setMobileOpen(true)} sx={{ mr: 1 }} aria-label="Open navigation">
              <MenuIcon />
            </IconButton>
          )}
          {pathname !== '/' && (
            <Tooltip title="Back">
              <IconButton onClick={back} sx={{ mr: 1 }} aria-label="Back">
                <ArrowBackIcon />
              </IconButton>
            </Tooltip>
          )}
          <Typography variant="subtitle1" sx={{ flexGrow: 1 }} noWrap>
            Gmail Submission Intake, Monitoring &amp; AI Review
          </Typography>
          {user && (
            <>
              {imsUrl && (
                <Tooltip title="Open IMS in a new tab">
                  <Button
                    component="a"
                    href={imsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    size="small"
                    variant="outlined"
                    endIcon={<OpenInNewIcon fontSize="small" />}
                    aria-label="Open IMS (opens in a new tab)"
                    sx={{ mr: 1, flexShrink: 0 }}
                  >
                    IMS
                  </Button>
                </Tooltip>
              )}
              <NotificationBell />
              <Tooltip title={`${user.email} · ${dotTitle}`}>
                <IconButton onClick={(e) => setMenuEl(e.currentTarget)} size="small" aria-label="Account menu">
                  <Badge
                    overlap="circular"
                    variant="dot"
                    anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                    sx={{
                      '& .MuiBadge-badge': {
                        bgcolor: dotColor,
                        width: 11,
                        height: 11,
                        minWidth: 11,
                        borderRadius: '50%',
                        boxShadow: (t) => `0 0 0 2px ${t.palette.background.paper}`,
                      },
                    }}
                  >
                    <Avatar sx={{ width: 30, height: 30, bgcolor: 'primary.main', fontSize: '0.8rem' }}>
                      {initials(user.name)}
                    </Avatar>
                  </Badge>
                </IconButton>
              </Tooltip>
              <Menu
                anchorEl={menuEl}
                open={!!menuEl}
                onClose={() => setMenuEl(null)}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                transformOrigin={{ vertical: 'top', horizontal: 'right' }}
              >
                <MenuItem disabled sx={{ opacity: '1 !important' }}>
                  <Stack
                    direction="row"
                    spacing={2}
                    alignItems="flex-start"
                    justifyContent="space-between"
                    sx={{ width: '100%' }}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="body2" fontWeight={600}>
                        {user.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {user.email}
                      </Typography>
                    </Box>
                    <Chip size="small" label={humanize(user.role)} variant="outlined" color="primary" />
                  </Stack>
                </MenuItem>
                {/* Service status is in Settings → Connections; the dot on the avatar still sums it up. */}
                <Divider />
                <MenuItem component={NavLink} to={paths.documents} onClick={() => setMenuEl(null)}>
                  <ListItemIcon>
                    <DescriptionIcon fontSize="small" />
                  </ListItemIcon>{' '}
                  Documents
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    setMenuEl(null);
                    setPasswordOpen(true);
                  }}
                >
                  <ListItemIcon>
                    <KeyIcon fontSize="small" />
                  </ListItemIcon>{' '}
                  Change password
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    setMenuEl(null);
                    setSignOutOpen(true);
                  }}
                >
                  <ListItemIcon>
                    <LogoutIcon fontSize="small" />
                  </ListItemIcon>{' '}
                  Sign out
                </MenuItem>
              </Menu>
              <ConfirmDialog
                open={signOutOpen}
                title="Sign out?"
                message="You will need to sign in again to continue."
                confirmLabel="Sign out"
                onConfirm={() => {
                  setSignOutOpen(false);
                  void logout();
                }}
                onCancel={() => setSignOutOpen(false)}
              />
              <ChangePasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />
            </>
          )}
        </Toolbar>
      </AppBar>
      <Box component="nav" sx={{ width: { md: DRAWER_WIDTH }, flexShrink: { md: 0 } }}>
        <Drawer
          variant={permanent ? 'permanent' : 'temporary'}
          open={permanent || mobileOpen}
          onClose={() => setMobileOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{ '& .MuiDrawer-paper': { width: DRAWER_WIDTH, boxSizing: 'border-box', border: 0 } }}
        >
          {drawer}
        </Drawer>
      </Box>
      <Box
        component="main"
        id={MAIN_ID}
        tabIndex={-1}
        sx={{ flexGrow: 1, minWidth: 0, pt: '56px', '&:focus': { outline: 'none' } }}
      >
        <Box sx={{ p: { xs: 1.5, sm: 2.5 }, maxWidth: 1600, mx: 'auto' }}>
          <ErrorBoundary resetKey={pathname} variant="section">
            <Outlet />
          </ErrorBoundary>
        </Box>
      </Box>
    </Box>
  );
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase())
      .join('') || '?'
  );
}
