---
name: forms-validation
description: Use when creating or editing any form or input on the frontend — React Hook Form (useForm, Controller, FormProvider), Zod schemas and zodResolver, RHF-bound MUI fields (TextField, Select, Autocomplete, DatePicker, Checkbox), inline field errors, submit/pending/disabled states, dirty-state guards, mapping server validation errors to fields, or sharing a Zod schema's rules with the backend. Applies to settings pages, quote inputs, manual field entry, email compose, and user management alike.
---

# Forms & Validation

Every form is **React Hook Form + a Zod schema**. The schema is the single statement of what valid input
is, the form type is inferred from it, and the same rules are re-checked on the server (client validation
is UX, not security).

Related: `api-integration` (mutations), `error-handling` (`fieldErrors`), `accessibility`, `node-api`.

## Rules

- **`useForm` with `zodResolver(schema)`, `defaultValues` for every field, `mode: 'onTouched'`.** Missing
  defaults make inputs flip between uncontrolled and controlled, and `onTouched` avoids yelling at users
  while they're still typing.
- **Schemas live in `features/<f>/schemas/<entity>.schema.ts`**; export `z.input` (field values) and
  `z.output` (submit payload) types, which are the same as `z.infer` only when nothing is coerced.
  Messages are user-ready, sentence case, and say how to fix ("Enter a 10-digit NPI").
- **Normalise in the schema:** `.trim()` strings, coerce numbers/dates (`z.coerce.number()`), turn empty
  strings into `undefined` for optional fields, and put cross-field rules in `.superRefine` with a `path`.
  Watch out: `z.coerce.number()` turns an empty input into `0`, so a blank required number passes
  `.min(0)`. Map `''` to `undefined` first (`z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number(…))`).
- **Input type differs from output type once you coerce or transform** (Zod 4 + `@hookform/resolvers` v5).
  Type the form as `useForm<z.input<typeof schema>, unknown, z.output<typeof schema>>` (or let
  `zodResolver` infer it); `handleSubmit` then receives the parsed output. Custom messages use Zod 4's
  `{ error: '…' }` option.
- **Use RHF-bound MUI fields from `@/components/form`** (`FormTextField`, `FormSelect`,
  `FormAutocomplete`, `FormCheckbox`, `FormRootError`). They wrap `Controller` once, so every form gets
  labels, `error`/`helperText`, and ARIA wiring for free.
- **Every field has a visible label** (MUI `label`), and errors render in `helperText` (MUI wires
  `aria-describedby` and `aria-invalid`). Placeholder is never the label.
- **Submit:** `type="submit"`, shows pending (`loading={isSubmitting}`), and is disabled only while
  submitting. Don't disable it for invalid forms; let submit reveal and focus the first error.
- **Call `mutateAsync` inside `handleSubmit`.** Server `fieldErrors` go to `setError(field)`; anything
  else goes to `setError('root.server')`, shown by `FormRootError` (`role="alert"`). The mutation sets
  `meta: { silentError: true }` so the global toast doesn't duplicate inline errors.
- **After success:** reset to the saved values (`reset(saved)`) or navigate, and give feedback.
- **Dirty forms are protected** from accidental navigation (see `routing-guards`).
- **Editing an entity:** remount the form with `key={entity.id}` and pass server data as `defaultValues`;
  don't `reset()` from an effect watching props.
- **Shared domain formats** (NPI 10 digits with Luhn check, US state codes, ZIP, email, money ≥ 0) are
  defined once in `@/lib/validators.ts` and reused by schemas.
- **Use `<form noValidate>`** so the Zod messages appear instead of the browser's.

## Patterns

```ts
// src/features/rating/schemas/quote-inputs.schema.ts
export const quoteInputsSchema = z.object({
  specialty: z.string().min(1, 'Choose a specialty'),
  state: usStateCode,                                     // from @/lib/validators
  limits: z.enum(LIMIT_OPTIONS, { error: 'Choose a limit' }),
  effectiveDate: z.coerce.date({ error: 'Enter a valid date' }),
  priorActsYears: z.preprocess((v) => (v === '' ? undefined : v),        // blank must not become 0
    z.coerce.number({ error: 'Enter the number of years' }).int().min(0, 'Can’t be negative').max(30, 'Enter 30 or fewer years')),
  notes: z.string().trim().max(2000, 'Keep notes under 2,000 characters').optional(),
}).superRefine((value, ctx) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);    // local midnight; no date library needed
  if (value.effectiveDate < today) ctx.addIssue({ code: 'custom', path: ['effectiveDate'], message: 'Effective date can’t be in the past' });
});
export type QuoteInputsValues = z.input<typeof quoteInputsSchema>; // what the fields hold
export type QuoteInputs = z.output<typeof quoteInputsSchema>;       // what submit receives
```

```tsx
// src/components/form/FormTextField.tsx
type FormTextFieldProps<T extends FieldValues> = { name: Path<T>; label: string } & Omit<TextFieldProps, 'name' | 'label' | 'value' | 'onChange' | 'error'>;

export function FormTextField<T extends FieldValues>({ name, label, helperText, ...rest }: FormTextFieldProps<T>) {
  const { control } = useFormContext<T>();
  return (
    <Controller name={name} control={control} render={({ field: { ref, ...field }, fieldState }) => (
      <TextField {...field} {...rest} inputRef={ref} label={label} fullWidth // inputRef lets RHF focus the first error
        value={field.value ?? ''} error={Boolean(fieldState.error)}
        helperText={fieldState.error?.message ?? helperText} />
    )} />
  );
}
```

```tsx
// A form using it
export function QuoteInputsForm({ quote }: { quote: Quote }) {
  const form = useForm<QuoteInputsValues, unknown, QuoteInputs>({ resolver: zodResolver(quoteInputsSchema), defaultValues: toFormValues(quote), mode: 'onTouched' });
  const save = useSaveQuoteInputs(quote.id); // meta: { silentError: true }
  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const saved = await save.mutateAsync(values);
      form.reset(toFormValues(saved));
      toast.success('Quote inputs saved');
    } catch (error) {
      applyServerErrors(toAppError(error), form.setError); // fieldErrors → fields, else root.server
    }
  });
  return (
    <FormProvider {...form}>
      <Box component="form" noValidate onSubmit={(e) => void onSubmit(e)} sx={{ display: 'grid', gap: 2 }}>
        <FormSelect<QuoteInputsValues> name="limits" label="Limits" options={LIMIT_OPTIONS} />
        <FormTextField<QuoteInputsValues> name="priorActsYears" label="Prior acts (years)" type="number" />
        <FormRootError />
        <Button type="submit" variant="contained" loading={form.formState.isSubmitting}>Save inputs</Button>
      </Box>
    </FormProvider>
  );
}
```

## Review checklist

- [ ] Zod schema + `zodResolver`; `defaultValues` for every field
- [ ] Fields come from `@/components/form`, each labelled with inline errors
- [ ] Submit shows pending, can't double-submit, isn't disabled for invalid input
- [ ] Server field errors land on fields; other errors in the root error
- [ ] Success resets to saved values or navigates, with feedback
- [ ] The backend validates the same rules (see `node-api`)
