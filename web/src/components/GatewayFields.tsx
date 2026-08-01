// The credential input, in ONE place.
//
// Two surfaces ask an operator to connect a service: the setup screen
// (OnboardingGateways) and the prerequisite gate a module raises when it needs
// one (ModuleSetupGate). They look different and live in different flows, but
// the field itself has rules that must not be re-decided per surface:
//
//   • A SECRET is write-only. The server never sends one back, so an empty box
//     means "leave what is there", never "erase it". That is why the
//     placeholder says so, and why a required field that is already `set` does
//     not count as missing.
//   • Direction is explicit: a key or a URL is always LTR, whatever the
//     browser's locale, because a half-typed token flipping direction mid-paste
//     is unreadable. Labels and help stay `auto`.
//   • The help line is the operator's only clue about WHERE the value comes
//     from, so it is rendered whenever the server sends one.
//
// Draft state deliberately stays with the CALLER: the setup screen keeps a
// draft per gateway so collapsing a panel does not lose a half-typed key, and
// the gate keeps one for the single gateway it is asking about. A component
// that owned the draft would take that choice away from both.

export type GatewayField = {
  key: string;
  label?: string;
  required?: boolean;
  secret?: boolean;
  help?: string | null;
  /** already has a value on this install (env or stored) */
  set?: boolean;
};

/**
 * Is this form still missing something it cannot be saved without?
 *
 * `requires: 'any'` is the social-gateway case: three webhook URLs, and one of
 * them is enough — so "missing" there means the operator has typed none of
 * them and none is already set.
 */
export function gatewayMissingRequired(
  fields: GatewayField[],
  draft: Record<string, string>,
  requires: 'all' | 'any' = 'all',
): boolean {
  const filled = (f: GatewayField) => f.set || Boolean((draft[f.key] ?? '').trim());
  if (requires === 'any') return fields.length > 0 && !fields.some(filled);
  return fields.some((f) => f.required && !filled(f));
}

/** Only what the operator actually typed. Empty boxes are left out entirely, so
 *  a save never clears a value the operator did not touch. */
export function gatewayConfigFrom(fields: GatewayField[], draft: Record<string, string>): Record<string, string> {
  const config: Record<string, string> = {};
  for (const f of fields) {
    const v = (draft[f.key] ?? '').trim();
    if (v) config[f.key] = v;
  }
  return config;
}

export function GatewayFieldInput({ field, value, onChange }: {
  field: GatewayField;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block pt-2">
      <span className="mono text-[9px] uppercase tracking-[0.16em] text-mute">
        {field.label || field.key}{field.required ? ' *' : ''}
      </span>
      <input
        type={field.secret ? 'password' : 'text'}
        autoComplete={field.secret ? 'new-password' : 'off'}
        dir={field.secret ? 'ltr' : 'auto'}
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.set ? 'already set — leave blank to keep' : ''}
        className="mt-1 w-full h-9 px-2.5 rounded-sm hairline bg-card text-[13px] outline-none focus:border-emerald-500"
      />
      {field.help && <span className="block mt-1 text-[11px] leading-relaxed text-mute">{field.help}</span>}
    </label>
  );
}
