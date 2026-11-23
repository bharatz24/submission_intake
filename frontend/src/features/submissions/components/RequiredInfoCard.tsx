// Documents & Evidence: the fields an underwriter needs before quoting. Missing ones are flagged with an Add; filled
// ones show the value in effect, its supporting document, and an Update. Both can attach or upload the document.
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/EditOutlined';
import { Button, Chip, Stack, Table, TableBody, TableCell, TableRow, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import { useState } from 'react';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { SectionCard } from '../../../components/common';
import { effectiveValue, fieldLabel, REQUIRED_FIELDS } from '../../../lib/fields';
import type { ManualField, SubmissionDetail } from '../../../types';
import { FieldDialog } from './FieldsCard';

type Open = { fieldName: string; existing?: ManualField; initialValue?: string };

export function RequiredInfoCard({ s }: { s: SubmissionDetail }) {
  const { user } = useAuth();
  const writable = hasPermission(user, 'submission:write');
  const [open, setOpen] = useState<Open | null>(null);
  const docName = (id: string | null) => s.documents.find((d) => d.id === id)?.filename ?? null;
  const rows = REQUIRED_FIELDS.map((name) => {
    const manual = s.manualFields
      .filter((f) => f.fieldName === name)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return { name, v: effectiveValue(name, s.extractedFields, s.manualFields), manual };
  });
  const missing = rows.filter((r) => !r.v).length;

  return (
    <SectionCard
      title="Required information"
      subtitle={missing ? `${missing} of ${rows.length} missing` : 'Complete'}
      actions={missing > 0 && <Chip size="small" color="warning" variant="outlined" label={`${missing} missing`} />}
    >
      <Table size="small" sx={{ '& td': { py: 0.5 } }}>
        <TableBody>
          {rows.map(({ name, v, manual }) => (
            <TableRow key={name} sx={v ? undefined : { bgcolor: (t) => alpha(t.palette.warning.main, 0.06) }}>
              <TableCell sx={{ color: 'text.secondary', width: 170 }}>{fieldLabel(name)}</TableCell>
              <TableCell sx={{ wordBreak: 'break-word' }}>
                {v ? (
                  <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Typography variant="body2">{v.value}</Typography>
                    {v.manual && (
                      <Chip size="small" color="primary" label="Manual" sx={{ height: 18, fontSize: '0.65rem' }} />
                    )}
                    {manual?.documentId && docName(manual.documentId) && (
                      <Typography variant="caption" color="text.secondary">
                        {docName(manual.documentId)}
                      </Typography>
                    )}
                  </Stack>
                ) : (
                  <Typography variant="body2" color="warning.main">
                    Missing
                  </Typography>
                )}
              </TableCell>
              {writable && (
                <TableCell align="right" sx={{ width: 110 }}>
                  {v ? (
                    <Button
                      size="small"
                      startIcon={<EditIcon />}
                      onClick={() =>
                        setOpen(
                          manual ? { fieldName: name, existing: manual } : { fieldName: name, initialValue: v.value },
                        )
                      }
                    >
                      Update
                    </Button>
                  ) : (
                    <Button size="small" startIcon={<AddIcon />} onClick={() => setOpen({ fieldName: name })}>
                      Add
                    </Button>
                  )}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {open && (
        <FieldDialog
          s={s}
          open
          fieldName={open.fieldName}
          existing={open.existing}
          initialValue={open.initialValue}
          onClose={() => setOpen(null)}
        />
      )}
    </SectionCard>
  );
}
