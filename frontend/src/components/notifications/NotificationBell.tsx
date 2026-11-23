// Header bell: unread badge (99+ at most) and a popover listing new Gmail emails.
import CloseIcon from '@mui/icons-material/Close';
import NotificationsIcon from '@mui/icons-material/NotificationsNoneOutlined';
import {
  Avatar,
  Badge,
  Box,
  Button,
  Divider,
  IconButton,
  List,
  ListItemAvatar,
  ListItemButton,
  ListItemText,
  Menu,
  MenuItem,
  Popover,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import { useState } from 'react';

import { badgeLabel, type ClearScope, type ConnectionStatus, idsToClear } from '../../lib/notifications';
import { formatRelative } from '../../lib/status';
import { useNotifications } from './NotificationProvider';

const CLEAR_OPTIONS: { scope: ClearScope; label: string }[] = [
  { scope: 'all', label: 'All' },
  { scope: 'read', label: 'Read only' },
  { scope: 'unread', label: 'Unread only' },
];

const STATUS: Record<ConnectionStatus, { label: string; color: string; hint: string }> = {
  live: { label: 'Live', color: 'success.main', hint: 'Receiving new emails as they arrive' },
  connecting: { label: 'Connecting', color: 'grey.500', hint: 'Connecting to the server…' },
  reconnecting: {
    label: 'Reconnecting',
    color: 'warning.main',
    hint: 'Connection lost; retrying. Missed emails are caught up on reconnect.',
  },
  offline: { label: 'Offline', color: 'error.main', hint: 'Not connected. Reload the page or check your network.' },
};

export function NotificationBell() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [clearAnchor, setClearAnchor] = useState<HTMLElement | null>(null);
  const { notifications, unread, status, markAllRead, clear, open } = useNotifications();
  const st = STATUS[status];

  return (
    <>
      <Tooltip title={unread ? `${unread} new email${unread > 1 ? 's' : ''}` : 'Notifications'}>
        <IconButton
          onClick={(e) => setAnchor(e.currentTarget)}
          sx={{ mr: 1 }}
          aria-label={`Notifications, ${unread} unread`}
        >
          <Badge badgeContent={unread ? badgeLabel(unread) : 0} color="error" invisible={!unread}>
            <NotificationsIcon />
          </Badge>
        </IconButton>
      </Tooltip>
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { width: 380, maxWidth: 'calc(100vw - 24px)' } } }}
      >
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 2, py: 1.25 }}>
          <Box>
            <Typography variant="subtitle2">Notifications</Typography>
            <Tooltip title={st.hint}>
              <Stack direction="row" spacing={0.75} alignItems="center" sx={{ width: 'fit-content' }}>
                <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: st.color }} />
                <Typography variant="caption" color="text.secondary">
                  {st.label}
                </Typography>
              </Stack>
            </Tooltip>
          </Box>
          <Stack direction="row" spacing={0.5}>
            <Button size="small" onClick={markAllRead} disabled={!unread}>
              Mark all as read
            </Button>
            <Button
              size="small"
              color="inherit"
              onClick={(e) => setClearAnchor(e.currentTarget)}
              disabled={!notifications.length}
              aria-haspopup="menu"
            >
              Clear
            </Button>
          </Stack>
          <Menu
            anchorEl={clearAnchor}
            open={!!clearAnchor}
            onClose={() => setClearAnchor(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          >
            {CLEAR_OPTIONS.map(({ scope, label }) => {
              const count = idsToClear(notifications, scope).length;
              return (
                <MenuItem
                  key={scope}
                  dense
                  disabled={!count}
                  onClick={() => {
                    setClearAnchor(null);
                    clear(scope);
                  }}
                >
                  {label}
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto', pl: 3 }}>
                    {count}
                  </Typography>
                </MenuItem>
              );
            })}
          </Menu>
        </Stack>
        <Divider />
        {notifications.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 3, textAlign: 'center' }}>
            New Gmail emails will appear here.
          </Typography>
        ) : (
          <List dense disablePadding sx={{ maxHeight: 420, overflowY: 'auto' }}>
            {notifications.map((n) => (
              <ListItemButton
                key={n.id}
                onClick={() => {
                  setAnchor(null);
                  open(n.id);
                }}
                sx={{
                  alignItems: 'flex-start',
                  bgcolor: (t) => (n.read ? 'transparent' : alpha(t.palette.primary.main, 0.07)),
                  '& .clear-one': { opacity: 0 },
                  '&:hover .clear-one, & .clear-one:focus-visible': { opacity: 1 },
                }}
              >
                <ListItemAvatar sx={{ minWidth: 44, mt: 0.5 }}>
                  <Avatar
                    sx={{ width: 32, height: 32, fontSize: '0.8rem', bgcolor: n.read ? 'grey.400' : 'primary.main' }}
                  >
                    {n.senderInitials}
                  </Avatar>
                </ListItemAvatar>
                <ListItemText
                  primary={
                    <Stack direction="row" justifyContent="space-between" spacing={1}>
                      <Typography variant="body2" fontWeight={n.read ? 500 : 700} noWrap>
                        {n.senderName}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                        {formatRelative(n.receivedAt)}
                      </Typography>
                    </Stack>
                  }
                  secondary={
                    <Typography
                      variant="caption"
                      color={n.read ? 'text.secondary' : 'text.primary'}
                      noWrap
                      component="span"
                      display="block"
                    >
                      {n.subject}
                    </Typography>
                  }
                />
                {!n.read && (
                  <Box
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      bgcolor: 'primary.main',
                      mt: 1.25,
                      ml: 1,
                      flexShrink: 0,
                    }}
                    aria-label="Unread"
                  />
                )}
                <Tooltip title="Clear">
                  <IconButton
                    className="clear-one"
                    size="small"
                    aria-label={`Clear notification: ${n.subject}`}
                    sx={{ ml: 0.5, mt: 0.25 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      clear({ id: n.id });
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <CloseIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
              </ListItemButton>
            ))}
          </List>
        )}
      </Popover>
    </>
  );
}
