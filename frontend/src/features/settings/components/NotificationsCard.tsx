import { Alert, Box, Button, Chip, List, ListItem, ListItemText, Switch, Typography } from '@mui/material';
import { type ReactNode, useState } from 'react';

import { useNotifications } from '../../../components/notifications/NotificationProvider';
import { SettingsPanel } from './SettingsShell';

/**
 * Settings → Notifications: how this user hears about new Gmail emails. Personal preferences, kept in this browser
 * (lib/notifications.ts), so every user can change them; the desktop permission belongs to the browser itself.
 */
export function NotificationsCard() {
  const { prefs, setPrefs, desktopPermission, requestDesktopPermission } = useNotifications();
  const [asking, setAsking] = useState(false);
  const enableDesktop = async () => {
    setAsking(true);
    try {
      await requestDesktopPermission();
    } finally {
      setAsking(false);
    }
  };
  const row = (label: string, hint: string, control: ReactNode) => (
    <ListItem divider sx={{ px: 0, gap: 2 }}>
      <ListItemText
        primary={
          <Typography variant="body2" fontWeight={600}>
            {label}
          </Typography>
        }
        secondary={hint}
      />
      <Box sx={{ flexShrink: 0 }}>{control}</Box>
    </ListItem>
  );

  return (
    <SettingsPanel
      title="Notifications"
      subtitle="How you hear about new Gmail emails. These are your own settings, saved in this browser."
    >
      <List dense disablePadding>
        {row(
          'Pop-up in the app',
          'A short pop-up in the corner of the app when a new email arrives.',
          <Switch
            checked={prefs.toasts}
            onChange={(e) => setPrefs({ ...prefs, toasts: e.target.checked })}
            inputProps={{ 'aria-label': 'Pop-up in the app' }}
          />,
        )}
        {row(
          'Desktop notifications',
          'A system notification when a new email arrives while this tab is in the background.',
          desktopPermission === 'granted' ? (
            <Switch
              checked={prefs.desktop}
              onChange={(e) => setPrefs({ ...prefs, desktop: e.target.checked })}
              inputProps={{ 'aria-label': 'Desktop notifications' }}
            />
          ) : desktopPermission === 'default' ? (
            <Button size="small" variant="outlined" disabled={asking} onClick={() => void enableDesktop()}>
              {asking ? 'Waiting for the browser…' : 'Enable desktop notifications'}
            </Button>
          ) : (
            <Chip
              size="small"
              variant="outlined"
              color={desktopPermission === 'denied' ? 'warning' : 'default'}
              label={desktopPermission === 'denied' ? 'Blocked by the browser' : 'Not supported'}
            />
          ),
        )}
      </List>
      {desktopPermission === 'denied' && (
        <Alert severity="info" variant="outlined" sx={{ mt: 1.5 }}>
          Desktop notifications are blocked for this site. Allow notifications in your browser's site settings (the icon
          next to the address bar), then reload the page.
        </Alert>
      )}
      {desktopPermission === 'unsupported' && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          This browser does not support desktop notifications.
        </Typography>
      )}
    </SettingsPanel>
  );
}
