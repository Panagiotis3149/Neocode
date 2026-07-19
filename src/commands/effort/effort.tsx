import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import { useAppState, useSetAppState } from '../../state/AppState.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { type EffortValue, getDisplayedEffortLevel, getEffortEnvOverride, getEffortValueDescription, isEffortLevel, isOpenAIEffortLevel, modelUsesOpenAIEffort, openAIEffortToStandard, toPersistableEffort } from '../../utils/effort.js';
import { EffortPicker } from '../../components/EffortPicker.js';
import { Select, type OptionWithDescription } from '../../components/CustomSelect/index.js';
import TextInput from '../../components/TextInput.js';
import { Box, Text } from '../../ink.js';
import { updateSettingsForSource } from '../../utils/settings/settings.js';
import {
  disableReasoningEffortOverride,
  getReasoningEffortOverride,
  listReasoningEffortOverrides,
  setReasoningEffortOverride,
} from '../../utils/effortOverrides.js';
import {
  disableRequestExtraOverride,
  getMergedRequestExtras,
  listRequestExtraOverrides,
  matchOverride,
  setRequestExtraOverride,
} from '../../utils/requestExtras.js';
const COMMON_HELP_ARGS = ['help', '-h', '--help'];
type EffortCommandResult = {
  message: string;
  effortUpdate?: {
    value: EffortValue | undefined;
  };
};
function setEffortValue(effortValue: EffortValue): EffortCommandResult {
  const persistable = toPersistableEffort(effortValue);
  if (persistable !== undefined) {
    const result = updateSettingsForSource('userSettings', {
      effortLevel: persistable
    });
    if (result.error) {
      return {
        message: `Failed to set effort level: ${result.error.message}`
      };
    }
  }
  logEvent('tengu_effort_command', {
    effort: effortValue as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });

  // Env var wins at resolveAppliedEffort time. Only flag it when it actually
  // conflicts — if env matches what the user just asked for, the outcome is
  // the same, so "Set effort to X" is true and the note is noise.
  const envOverride = getEffortEnvOverride();
  if (envOverride !== undefined && envOverride !== effortValue) {
    const envRaw = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    if (persistable === undefined) {
      return {
        message: `Not applied: CLAUDE_CODE_EFFORT_LEVEL=${envRaw} overrides effort this session, and ${effortValue} is session-only (nothing saved)`,
        effortUpdate: {
          value: effortValue
        }
      };
    }
    return {
      message: `CLAUDE_CODE_EFFORT_LEVEL=${envRaw} overrides this session — clear it and ${effortValue} takes over`,
      effortUpdate: {
        value: effortValue
      }
    };
  }
  const description = getEffortValueDescription(effortValue);
  const suffix = persistable !== undefined ? '' : ' (this session only)';
  return {
    message: `Set effort level to ${effortValue}${suffix}: ${description}`,
    effortUpdate: {
      value: effortValue
    }
  };
}
export function showCurrentEffort(appStateEffort: EffortValue | undefined, model: string): EffortCommandResult {
  const envOverride = getEffortEnvOverride();
  const effectiveValue = envOverride === null ? undefined : envOverride ?? appStateEffort;
  if (effectiveValue === undefined) {
    const level = getDisplayedEffortLevel(model, appStateEffort);
    return {
      message: `Effort level: auto (currently ${level})`
    };
  }
  const description = getEffortValueDescription(effectiveValue);
  return {
    message: `Current effort level: ${effectiveValue} (${description})`
  };
}
function unsetEffortLevel(): EffortCommandResult {
  const result = updateSettingsForSource('userSettings', {
    effortLevel: undefined
  });
  if (result.error) {
    return {
      message: `Failed to set effort level: ${result.error.message}`
    };
  }
  logEvent('tengu_effort_command', {
    effort: 'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
  // env=auto/unset (null) matches what /effort auto asks for, so only warn
  // when env is pinning a specific level that will keep overriding.
  const envOverride = getEffortEnvOverride();
  if (envOverride !== undefined && envOverride !== null) {
    const envRaw = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    return {
      message: `Cleared effort from settings, but CLAUDE_CODE_EFFORT_LEVEL=${envRaw} still controls this session`,
      effortUpdate: {
        value: undefined
      }
    };
  }
  return {
    message: 'Effort level set to auto',
    effortUpdate: {
      value: undefined
    }
  };
}
export function executeEffort(args: string): EffortCommandResult {
  const normalized = args.toLowerCase();
  if (normalized === 'auto' || normalized === 'unset') {
    return unsetEffortLevel();
  }
  if (isEffortLevel(normalized)) {
    return setEffortValue(normalized);
  }
  if (isOpenAIEffortLevel(normalized)) {
    // Normalize OpenAI-shaped 'xhigh' → standard 'max' so it persists.
    return setEffortValue(openAIEffortToStandard(normalized));
  }
  return {
    message: `Invalid argument: ${args}. Valid options are: low, medium, high, max, xhigh, auto`
  };
}
function ShowCurrentEffort(t0) {
  const {
    onDone
  } = t0;
  const effortValue = useAppState(_temp);
  const model = useMainLoopModel();
  const {
    message
  } = showCurrentEffort(effortValue, model);
  onDone(message);
  return null;
}
function _temp(s) {
  return s.effortValue;
}
function ApplyEffortAndClose(t0) {
  const $ = _c(6);
  const {
    result,
    onDone
  } = t0;
  const setAppState = useSetAppState();
  const {
    effortUpdate,
    message
  } = result;
  let t1;
  let t2;
  if ($[0] !== effortUpdate || $[1] !== message || $[2] !== onDone || $[3] !== setAppState) {
    t1 = () => {
      if (effortUpdate) {
        setAppState(prev => ({
          ...prev,
          effortValue: effortUpdate.value
        }));
      }
      onDone(message);
    };
    t2 = [setAppState, effortUpdate, message, onDone];
    $[0] = effortUpdate;
    $[1] = message;
    $[2] = onDone;
    $[3] = setAppState;
    $[4] = t1;
    $[5] = t2;
  } else {
    t1 = $[4];
    t2 = $[5];
  }
  React.useEffect(t1, t2);
  return null;
}
function EffortHelp(t0) {
  const {
    onDone
  } = t0;
  const model = useMainLoopModel();
  const effortOverride = getReasoningEffortOverride(model);
  const extraOverrides = listRequestExtraOverrides().filter(o => o.enabled !== false && matchOverride(o, model));
  const customLines = [];
  if (effortOverride) {
    customLines.push(`  • reasoning_effort override → "${effortOverride.param}" (matches "${effortOverride.match}")`);
  }
  if (extraOverrides.length > 0) {
    for (const ex of extraOverrides) {
      customLines.push(`  • custom request extras (matches "${ex.match}")`);
    }
  }
  const customBlock = customLines.length > 0 ? `\n\nThis model ("${model}") has custom setup:\n` + customLines.join('\n') + '\n' : `\n\nThis model ("${model}") has no custom setup.`;
  const message = 'Usage: /effort [low|medium|high|max|xhigh|auto]\n\nEffort levels:\n- low: Quick, straightforward implementation\n- medium: Balanced approach with standard testing\n- high: Comprehensive implementation with extensive testing\n- max: Maximum capability with deepest reasoning (Opus 4.6 only)\n- xhigh: Extra-high reasoning for OpenAI/Codex models (alias for max)\n- auto: Use the default effort level for your model\n\nReasoning-effort overrides (provider/route based):\n  /effort enable <model|prefix*> [param]  Enable reasoning_effort for a model or prefix (e.g. novita/*, nvidia/*). param defaults to an interactive picker.\n  /effort disable <model|prefix*>      Disable a previously enabled override.\n  /effort list                         List active reasoning-effort overrides.\n\nCustom raw-JSON request extras (for params the flat override can\'t express, e.g. extra_body.chat_template_kwargs):\n  /effort extras add <model|prefix*|*>   Add/overwrite a raw-JSON body override for a scope (paste JSON).\n  /effort extras list                  List active raw-JSON extras.\n  /effort extras disable <model|prefix*|*>  Turn off an extras override.\n  Use "$reasoning_effort" inside the JSON to substitute the current effort level.' + customBlock;
  React.useEffect(() => {
    onDone(message);
  }, []);
  return null;
}
export async function call(onDone: LocalJSXCommandOnDone, _context: unknown, args?: string): Promise<React.ReactNode> {
  args = args?.trim() || '';
  if (COMMON_HELP_ARGS.includes(args)) {
    return <EffortHelp onDone={onDone} />;
  }
  if (args === 'current' || args === 'status' || args === 'list') {
    if (args === 'list') {
      return <ShowOverrides onDone={onDone} />;
    }
    return <ShowCurrentEffort onDone={onDone} />;
  }
  if (!args) {
    return <EffortPickerWrapper onDone={onDone} />;
  }
  const parts = args.split(/\s+/).filter(Boolean);
  const subcommand = parts[0]?.toLowerCase();
  if (subcommand === 'extras') {
    const verb = parts[1]?.toLowerCase();
    if (verb === 'list') {
      return <ShowExtras onDone={onDone} />;
    }
    if (verb === 'disable' || verb === 'off') {
      const match = parts[2]?.trim();
      if (!match) {
        onDone('Usage: /effort extras disable <model|prefix*|*>');
        return;
      }
      return <ExtrasDisableApply match={match} onDone={onDone} />;
    }
    if (verb === 'add') {
      const match = (parts[2] ?? '').trim();
      return <ExtrasEditor match={match} onDone={onDone} />;
    }
    // bare "extras" with no verb → interactive editor, scoped to current model
    return <ExtrasEditor match="" onDone={onDone} />;
  }
  if (subcommand === 'enable') {
    const pattern = parts[1]?.trim();
    const param = parts[2]?.trim();
    if (pattern && param) {
      return <EffortEnableApply pattern={pattern} param={param} onDone={onDone} />;
    }
    return <EffortParamPicker pattern={pattern} onDone={onDone} />;
  }
  if (subcommand === 'disable') {
    const match = parts[1]?.trim();
    if (!match) {
      onDone('Usage: /effort disable <model|prefix*>');
      return;
    }
    return <EffortDisableApply match={match} onDone={onDone} />;
  }
  const result = executeEffort(args);
  return <ApplyEffortAndClose result={result} onDone={onDone} />;
}

function EffortPickerWrapper({ onDone }: { onDone: LocalJSXCommandOnDone }) {
  const setAppState = useSetAppState();
  const model = useMainLoopModel();
  const usesOpenAIEffort = modelUsesOpenAIEffort(model);
  const [customView, setCustomView] = React.useState<React.ReactNode | null>(null);

  function handleSelect(effort: EffortValue | undefined) {
    const persistable = toPersistableEffort(effort);
    if (persistable !== undefined) {
      updateSettingsForSource('userSettings', {
        effortLevel: persistable
      });
    }
    logEvent('tengu_effort_command', {
      effort: (effort ?? 'auto') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    setAppState(prev => ({
      ...prev,
      effortValue: effort
    }));
    const description = effort ? getEffortValueDescription(effort) : 'Use default effort level for your model';
    const suffix = persistable !== undefined ? '' : ' (this session only)';
    onDone(`Set effort level to ${effort ?? 'auto'}${suffix}: ${description}`);
  }

  function handleCancel() {
    onDone('Cancelled');
  }

  function handleCustom() {
    setCustomView(<CustomEffortSetup onDone={onDone} />);
  }

  if (customView) {
    return <>{customView}</>;
  }

  const customSetup = (() => {
    const effort = getReasoningEffortOverride(model);
    const extras = getMergedRequestExtras(model);
    const extrasKeys: string[] = [];
    const collect = (obj: Record<string, unknown>, prefix: string) => {
      for (const [k, v] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          collect(v as Record<string, unknown>, path);
        } else {
          extrasKeys.push(path);
        }
      }
    }
    collect(extras, '');
    return { effort, extrasKeys };
  })();

  const customConfig =
    customSetup.effort || customSetup.extrasKeys.length > 0
      ? {
          match: model,
          detail:
            customSetup.effort?.param
              ? `reasoning_effort "${customSetup.effort.param}"${customSetup.extrasKeys.length > 0 ? ` + ${customSetup.extrasKeys.length} extra key(s)` : ''}`
              : `${customSetup.extrasKeys.length} custom extra key(s)`,
        }
      : undefined;

  return (
    <Box flexDirection="column">
      {customSetup.effort || customSetup.extrasKeys.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="warning">
            Custom setup active for this model:
          </Text>
          {customSetup.effort ? (
            <Text dimColor={true}>
              {'  '}reasoning-effort → {customSetup.effort.param}
            </Text>
          ) : null}
          {customSetup.extrasKeys.length > 0 ? (
            <Text dimColor={true}>
              {'  '}request extras → {customSetup.extrasKeys.join(', ')}
            </Text>
          ) : null}
        </Box>
      ) : null}
      <EffortPicker
        onSelect={handleSelect}
        onCancel={handleCancel}
        onCustom={handleCustom}
        customConfig={customConfig}
      />
    </Box>
  );
}

/**
 * Result helpers for the override subcommands. Each writes to `userSettings`
 * (persisted) so the override survives restarts — matching the decision to
 * persist effort overrides by default.
 */
function applyEnableOverride(pattern: string, param: string): EffortCommandResult {
  const result = setReasoningEffortOverride({ match: pattern, param });
  if (result.error) {
    return { message: `Failed to enable effort override: ${result.error.message}` };
  }
  logEvent('tengu_effort_command', { effort: 'enable-override' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS });
  const scope = pattern.endsWith('*') ? `prefix ${pattern}` : `model ${pattern}`;
  return {
    message: `Enabled reasoning-effort override for ${scope} → sends "${param}" on the wire (persisted)`
  };
}

function applyDisableOverride(match: string): EffortCommandResult {
  const result = disableReasoningEffortOverride(match);
  if (result.error) {
    return { message: `Failed to disable effort override: ${result.error.message}` };
  }
  logEvent('tengu_effort_command', { effort: 'disable-override' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS });
  return { message: `Disabled reasoning-effort override matching "${match}"` };
}

function renderOverridesList(): EffortCommandResult {
  const overrides = listReasoningEffortOverrides();
  if (overrides.length === 0) {
    return { message: 'No reasoning-effort overrides configured.' };
  }
  const lines = overrides.map(o => {
    const status = o.enabled ? 'on ' : 'off';
    return `  [${status}] ${o.match}  →  ${o.param}`;
  });
  return { message: `Active reasoning-effort overrides:\n${lines.join('\n')}` };
}

function EffortEnableApply({ pattern, param, onDone }: { pattern: string; param: string; onDone: LocalJSXCommandOnDone }) {
  const result = applyEnableOverride(pattern, param);
  React.useEffect(() => {
    onDone(result.message);
  }, []);
  return null;
}

function EffortDisableApply({ match, onDone }: { match: string; onDone: LocalJSXCommandOnDone }) {
  const result = applyDisableOverride(match);
  React.useEffect(() => {
    onDone(result.message);
  }, []);
  return null;
}

function ShowOverrides({ onDone }: { onDone: LocalJSXCommandOnDone }) {
  const { message } = renderOverridesList();
  React.useEffect(() => {
    onDone(message);
  }, []);
  return null;
}

/** Menu of common wire params + a free-text input option. */
function EffortParamPicker({ pattern, onDone }: { pattern: string; onDone: LocalJSXCommandOnDone }) {
  const model = useMainLoopModel();
  const candidate = pattern || model;
  const [phase, setPhase] = React.useState<'menu' | 'text'>('menu');
  const [typed, setTyped] = React.useState('');

  const COMMON_PARAMS = ['reasoning_effort', 'reasoning', 'thinking'];

  function finish(param: string) {
    const trimmed = param.trim();
    if (!trimmed) {
      onDone('Cancelled: empty param name');
      return;
    }
    const result = applyEnableOverride(pattern && pattern.trim() ? pattern.trim() : candidate, trimmed);
    onDone(result.message);
  }

  if (phase === 'text') {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold={true} color="remember">Enter the wire param name</Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor={true}>For {pattern || candidate}. e.g. reasoning_effort, reasoning, thinking. Esc to cancel.</Text>
        </Box>
        <TextInput
          value={typed}
          onChange={setTyped}
          onSubmit={finish}
          columns={80}
        />
      </Box>
    );
  }

  const options: OptionWithDescription[] = [
    ...COMMON_PARAMS.map(param => ({
      label: param,
      value: param,
      description: `Send "${param}" on the request body`,
      isAvailable: true,
    })),
    {
      label: 'Custom… (type your own)',
      value: '__custom__',
      description: 'Choose a different wire param name via free text',
      isAvailable: true,
      type: 'input',
      placeholder: 'reasoning_effort',
      onChange: () => {
        setPhase('text');
      },
    } as OptionWithDescription,
  ];

  function handleSelect(value: string) {
    if (value === '__custom__') {
      setPhase('text');
      return;
    }
    finish(value);
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Text color="remember" bold={true}>Choose reasoning wire param</Text>
        <Text dimColor={true}>
          {pattern ? `For ${pattern}` : `For current model ${candidate}`}
          {' · persisted to user settings'}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Select
          options={options}
          onChange={handleSelect}
          onCancel={() => onDone('Cancelled')}
          visibleOptionCount={Math.min(6, options.length)}
          inlineDescriptions={true}
        />
      </Box>
    </Box>
  );
}

/**
 * Guided "Custom…" setup reachable from the base /effort picker when the
 * current model doesn't support effort natively. Makes enabling effort for a
 * custom (e.g. OpenRouter/Novita/Nvidia) model a two-step flow instead of
 * requiring two separate commands.
 */
function CustomEffortSetup({ onDone }: { onDone: LocalJSXCommandOnDone }) {
  const model = useMainLoopModel();
  const candidate = model;
  const [phase, setPhase] = React.useState<'pattern' | 'format'>('pattern');
  const [matchText, setMatchText] = React.useState(candidate);

  function applyFlat(param: string) {
    const result = applyEnableOverride(matchText.trim(), param);
    onDone(result.message);
  }

  function applyNested() {
    const result = setRequestExtraOverride({
      match: matchText.trim(),
      json: { extra_body: { chat_template_kwargs: { reasoning_effort: '$reasoning_effort' } } },
    });
    if (result.error) {
      onDone(`Failed: ${result.error.message}`);
      return;
    }
    onDone(`Enabled nested effort for "${matchText.trim()}" → extra_body.chat_template_kwargs.reasoning_effort (persisted). Set the level with /effort <low|medium|high>.`);
  }

  if (phase === 'format') {
    const options: OptionWithDescription[] = [
      {
        label: 'OpenRouter / Novita — reasoning_effort',
        value: 'reasoning_effort',
        description: 'Flat param: sends { "reasoning_effort": "<level>" } on the wire',
        isAvailable: true,
      },
      {
        label: 'Nvidia / others — reasoning',
        value: 'reasoning',
        description: 'Flat param: sends { "reasoning": "<level>" }',
        isAvailable: true,
      },
      {
        label: 'Tencent / Novita — nested extra_body',
        value: '__nested__',
        description: 'Sends extra_body.chat_template_kwargs.reasoning_effort (deep-nested providers)',
        isAvailable: true,
      },
      {
        label: 'Free-form JSON…',
        value: '__json__',
        description: 'Open the full raw-JSON editor (any shape, any scope)',
        isAvailable: true,
      },
    ];
    function handleFormat(value: string) {
      if (value === '__nested__') {
        applyNested();
        return;
      }
      if (value === '__json__') {
        return <ExtrasEditor match={matchText.trim()} onDone={onDone} />;
      }
      applyFlat(value);
    }
    return (
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="column">
          <Text color="remember" bold={true}>Effort wire format for {matchText.trim()}</Text>
          <Text dimColor={true}>Tell Neocode how your provider expects the reasoning effort. (persisted)</Text>
        </Box>
        <Select
          options={options}
          onChange={handleFormat}
          onCancel={() => onDone('Cancelled')}
          visibleOptionCount={Math.min(6, options.length)}
          inlineDescriptions={true}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold={true} color="remember">Custom effort setup — model / scope</Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor={true}>Exact model id, "prefix*" (e.g. tencent/*, openrouter/*), or "*" for all models. Esc to cancel.</Text>
      </Box>
      <TextInput
        value={matchText}
        onChange={setMatchText}
        onSubmit={() => setPhase('format')}
        columns={80}
      />
    </Box>
  );
}

function renderExtrasList(): { message: string } {
  const overrides = listRequestExtraOverrides();
  if (!overrides.length) {
    return { message: 'No raw-JSON request extras configured.' };
  }
  const lines = overrides.map(o => {
    const status = o.enabled ? 'on ' : 'off';
    return `  [${status}] ${o.match}  →  ${JSON.stringify(o.json)}`;
  });
  return { message: `Active raw-JSON request extras:\n${lines.join('\n')}` };
}

function ShowExtras({ onDone }: { onDone: LocalJSXCommandOnDone }) {
  const { message } = renderExtrasList();
  React.useEffect(() => {
    onDone(message);
  }, []);
  return null;
}

function ExtrasDisableApply({ match, onDone }: { match: string; onDone: LocalJSXCommandOnDone }) {
  const result = disableRequestExtraOverride(match);
  React.useEffect(() => {
    onDone(result.error ? `Failed: ${result.error.message}` : `Disabled raw-JSON extras for "${match}"`);
  }, []);
  return null;
}

/**
 * Interactive editor for a raw-JSON body override. Offers a quick preset for
 * the common `extra_body.chat_template_kwargs.reasoning_effort` case plus a
 * free-text paste of arbitrary JSON. The scope (match) is editable: exact
 * model id, "prefix*", or "*" for global.
 */
function ExtrasEditor({ match, onDone }: { match: string; onDone: LocalJSXCommandOnDone }) {
  const model = useMainLoopModel();
  const candidate = match || model;
  const [phase, setPhase] = React.useState<'menu' | 'match' | 'json'>('menu');
  const [matchText, setMatchText] = React.useState(candidate);
  const [jsonText, setJsonText] = React.useState('');
  const [error, setError] = React.useState('');

  function openJson(initial: string) {
    setJsonText(initial);
    setPhase('json');
  }

  function apply() {
    const parsed = safeParse(jsonText);
    if (parsed.error || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
      setError('Invalid JSON object. Paste a JSON object, e.g. {"extra_body":{"chat_template_kwargs":{"reasoning_effort":"high"}}}');
      return;
    }
    const result = setRequestExtraOverride({ match: matchText.trim(), json: parsed.value as Record<string, unknown> });
    if (result.error) {
      onDone(`Failed: ${result.error.message}`);
      return;
    }
    onDone(`Saved raw-JSON extras for "${matchText.trim()}" → ${JSON.stringify(result.entry?.json)} (persisted)`);
  }

  function safeParse(text: string): { value: unknown; error: boolean } {
    try {
      return { value: JSON.parse(text), error: false };
    } catch {
      return { value: null, error: true };
    }
  }

  if (phase === 'json') {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold={true} color="remember">Paste raw JSON for {matchText.trim() || '(scope unset)'}</Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor={true}>Deep-merged into the request body. Use "$reasoning_effort" to substitute the current effort level. Esc to cancel.</Text>
        </Box>
        <TextInput
          value={jsonText}
          onChange={(v: string) => { setJsonText(v); setError(''); }}
          onSubmit={apply}
          columns={120}
        />
        {error ? (
          <Box marginTop={1}>
            <Text color="error">{error}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  if (phase === 'match') {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold={true} color="remember">Scope for this override</Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor={true}>Exact model id, "prefix*" (e.g. tencent/*, openrouter/*), or "*" for all models.</Text>
        </Box>
        <TextInput
          value={matchText}
          onChange={setMatchText}
          onSubmit={() => openJson('')}
          columns={80}
        />
      </Box>
    );
  }

  const EXTRA_PRESETS = [
    {
      label: 'extra_body.chat_template_kwargs.reasoning_effort',
      value: 'preset-nested',
      description: 'Nested provider param (e.g. tencent/hy3 via Novita) using "$reasoning_effort"',
    },
    {
      label: 'Top-level reasoning_effort',
      value: 'preset-top',
      description: 'Send { "reasoning_effort": "$reasoning_effort" } at root',
    },
    {
      label: 'Custom… (type your own)',
      value: '__custom__',
      description: 'Free-text paste of arbitrary JSON',
    },
    {
      label: 'Set scope (model / prefix* / *)',
      value: '__scope__',
      description: 'Change which model/prefix this override applies to',
    },
  ];
  function handleSelect(value: string) {
    if (value === 'preset-nested') {
      openJson('{ "extra_body": { "chat_template_kwargs": { "reasoning_effort": "$reasoning_effort" } } }');
      return;
    }
    if (value === 'preset-top') {
      openJson('{ "reasoning_effort": "$reasoning_effort" }');
      return;
    }
    if (value === '__custom__') {
      openJson('');
      return;
    }
    if (value === '__scope__') {
      setPhase('match');
      return;
    }
  }
  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Text color="remember" bold={true}>Add raw-JSON request extras</Text>
        <Text dimColor={true}>
          {matchText ? `Scope: ${matchText}` : `Scope: current model ${candidate} (editable next)`}
          {' · persisted to user settings'}
        </Text>
      </Box>
      <Box marginBottom={1} flexDirection="column">
        <Text dimColor={true}>Pick a template, or choose Custom to paste JSON:</Text>
      </Box>
      <Select
        options={EXTRA_PRESETS.map(p => ({ ...p, isAvailable: true }))}
        onChange={handleSelect}
        onCancel={() => onDone('Cancelled')}
        visibleOptionCount={Math.min(6, EXTRA_PRESETS.length)}
        inlineDescriptions={true}
      />
      <Box marginTop={1}>
        <Text dimColor={true}>Run again with a different scope: /effort extras add &lt;model|prefix*|*&gt;</Text>
      </Box>
    </Box>
  );
}
