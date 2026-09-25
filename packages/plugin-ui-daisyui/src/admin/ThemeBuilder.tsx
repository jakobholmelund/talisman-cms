import React, { useEffect, useState } from 'react';
import { DAISYUI_THEME_DEFAULTS } from './themeDefaults';
import {
  DAISYUI_THEME_ADVANCED,
  DAISYUI_THEME_COLORS,
  isSafeThemeColor,
  isSafeThemeNumber,
} from '../components/theme-css';
import {
  colorToHex,
  createThemeEditorState,
  normalizeColorInput,
  themeDefaultValue,
  themeEditorPayload,
  themeNamesFor,
  type ThemeEditorState,
  type ThemeMode,
} from './theme-editor';

type Overrides = Record<string, string>;

const withValue = (values: Overrides, key: string, value: string) => {
  const next = { ...values };
  // An empty field means "use the base theme", so it is not stored as an override.
  if (value.trim() === '') delete next[key];
  else next[key] = value;
  return next;
};

const isInvalidColor = (value: string | undefined) => value !== undefined && !isSafeThemeColor(normalizeColorInput(value));
const isInvalidNumber = (value: string | undefined) => value !== undefined && !isSafeThemeNumber(value);

export default function ThemeBuilder() {
  const [lightColors, setLightColors] = useState<Overrides>({});
  const [darkColors, setDarkColors] = useState<Overrides>({});
  const [lightTheme, setLightTheme] = useState('light');
  const [darkTheme, setDarkTheme] = useState('dark');
  const [editMode, setEditMode] = useState<ThemeMode>('light');
  const [previewMode, setPreviewMode] = useState<ThemeMode>('light');
  const [advanced, setAdvanced] = useState<Overrides>({});
  const [isSaving, setIsSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [layoutOptions, setLayoutOptions] = useState<string[]>([]);
  const [selectedLayout, setSelectedLayout] = useState<string>('');

  const applyState = (state: ThemeEditorState) => {
    setLightTheme(state.lightTheme);
    setDarkTheme(state.darkTheme);
    setLightColors(state.lightColors);
    setDarkColors(state.darkColors);
    setAdvanced(state.advanced);
  };

  useEffect(() => {
    // Determine admin base path from URL pattern /admin/...
    const pathParts = window.location.pathname.split('/');
    const basePath = pathParts[1] === 'extensions' ? '' : `/${pathParts[1]}`;
    const apiPath = `${basePath}/api/daisyui/theme`;
    const layoutsApiPath = `${basePath}/api/daisyui/layouts`;

    Promise.all([
      fetch(apiPath)
        .then(async (res) => {
          if (!res.ok) throw new Error(`the server answered ${res.status}`);
          return res.json();
        })
        .catch((err) => {
          // Saving now would replace the stored theme with an empty one, so saving stays off.
          setLoadError(`Could not load the saved theme (${err instanceof Error ? err.message : 'network error'}). Reload the page to try again; saving is disabled so the saved theme is not overwritten.`);
          return {};
        }),
      fetch(layoutsApiPath).then((res) => res.json()).catch(() => ({ layouts: [] }))
    ])
      .then(([data, layoutsData]) => {
        // Only saved overrides are loaded. Everything else shows the base theme's daisyUI values and
        // is not saved, so a first save keeps daisyUI's own light and dark palettes.
        applyState(createThemeEditorState(data));

        if (layoutsData && layoutsData.layouts) {
          setLayoutOptions(layoutsData.layouts);
          setSelectedLayout(layoutsData.layouts[0] || '');
        }
      })
      .catch((err) => console.error('Failed to fetch theme or layouts:', err))
      .finally(() => setLoading(false));
  }, []);

  const handleThemeChange = (mode: ThemeMode, themeName: string) => {
    const overrides = mode === 'light' ? lightColors : darkColors;
    const count = Object.keys(overrides).length;
    // Overrides were picked to go with the previous base theme, so a new base theme starts clean.
    if (count > 0 && !window.confirm(
      `Switching the ${mode} theme to "${themeName}" clears your ${count} ${mode} colour override${count === 1 ? '' : 's'}. Continue?`,
    )) {
      return;
    }

    if (mode === 'light') {
      setLightTheme(themeName);
      setLightColors({});
    } else {
      setDarkTheme(themeName);
      setDarkColors({});
    }
  };

  const handleColorChange = (id: string, value: string) => {
    if (editMode === 'light') {
      setLightColors((prev) => withValue(prev, id, value));
    } else {
      setDarkColors((prev) => withValue(prev, id, value));
    }
  };
  const handleResetColors = () => {
    if (editMode === 'light') setLightColors({});
    else setDarkColors({});
  };
  const handleAdvancedChange = (id: string, value: string) => {
    setAdvanced((prev) => withValue(prev, id, value));
  };

  const payload = () => themeEditorPayload({ lightTheme, darkTheme, lightColors, darkColors, advanced });

  const invalidFields = [
    ...Object.keys(lightColors).filter((key) => isInvalidColor(lightColors[key])).map((key) => `light ${key}`),
    ...Object.keys(darkColors).filter((key) => isInvalidColor(darkColors[key])).map((key) => `dark ${key}`),
    ...Object.keys(advanced).filter((key) => isInvalidNumber(advanced[key])),
  ];

  const handleSave = async () => {
    setIsSaving(true);
    setSuccess(false);

    try {
      const pathParts = window.location.pathname.split('/');
      const basePath = pathParts[1] === 'extensions' ? '' : `/${pathParts[1]}`;
      const apiPath = `${basePath}/api/daisyui/theme`;

      const res = await fetch(apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload()),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        const fields = Array.isArray(body?.fields) ? body.fields.join(', ') : '';
        alert(fields ? `Error saving theme: these values are not allowed: ${fields}` : 'Error saving theme');
        return;
      }

      applyState(createThemeEditorState(body));
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      console.error(err);
      alert('Error saving theme');
    } finally {
      setIsSaving(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-zinc-400">Loading theme builder...</div>;
  }

  const editTheme = editMode === 'light' ? lightTheme : darkTheme;
  const editColors = editMode === 'light' ? lightColors : darkColors;
  const editOverrideCount = Object.keys(editColors).length;
  const previewTheme = previewMode === 'light' ? lightTheme : darkTheme;
  const previewColors = previewMode === 'light' ? lightColors : darkColors;

  const handleOpenPreview = () => {
    sessionStorage.setItem('daisyui-preview-state', JSON.stringify(payload()));
    const url = `/admin/daisyui-preview?mode=${previewMode}${selectedLayout ? `&layout=${encodeURIComponent(selectedLayout)}` : ''}`;
    window.open(url, '_blank');
  };

  // What the mini preview shows: a valid override, else the base theme's value. Themes that daisyUI
  // does not ship fall back to its plain light or dark theme.
  const baseValue = (theme: string, mode: ThemeMode, key: string) =>
    themeDefaultValue(theme, key) ?? themeDefaultValue(mode, key) ?? '';
  const previewColor = (key: string) => {
    const override = previewColors[key];
    return override !== undefined && !isInvalidColor(override)
      ? normalizeColorInput(override)
      : baseValue(previewTheme, previewMode, key);
  };
  const previewVar = (key: string) => {
    const override = advanced[key];
    return override !== undefined && !isInvalidNumber(override) ? override.trim() : baseValue(previewTheme, previewMode, key);
  };

  // Mini preview generated via style injected safely
  const previewStyles = {
    '--preview-p': previewColor('primary'),
    '--preview-pc': previewColor('primary-content'),
    '--preview-s': previewColor('secondary'),
    '--preview-sc': previewColor('secondary-content'),
    '--preview-a': previewColor('accent'),
    '--preview-ac': previewColor('accent-content'),
    '--preview-b1': previewColor('base-100'),
    '--preview-b2': previewColor('base-200'),
    '--preview-b3': previewColor('base-300'),
    '--preview-bc': previewColor('base-content'),
    '--preview-suc': previewColor('success'),
    '--preview-succ': previewColor('success-content'),
    '--preview-err': previewColor('error'),
    '--preview-errc': previewColor('error-content'),
  } as React.CSSProperties;
  const radiusBox = previewVar('radius-box');
  const radiusField = previewVar('radius-field');
  const radiusSelector = previewVar('radius-selector');
  const borderWidth = previewVar('border');

  const themeOptions = (mode: ThemeMode, current: string) => themeNamesFor(mode, current).map((name) => {
    const scheme = DAISYUI_THEME_DEFAULTS[name]?.colorScheme;
    const note = !scheme ? ' (not a built-in theme)' : scheme !== mode ? ` (${scheme} theme)` : '';
    return <option key={name} value={name}>{name}{note}</option>;
  });

  const advancedPlaceholder = (key: string) => {
    const light = baseValue(lightTheme, 'light', key);
    const dark = baseValue(darkTheme, 'dark', key);
    return light === dark ? light : `${light} light, ${dark} dark`;
  };

  return (
    <div className="flex flex-col lg:flex-row gap-8 p-6" style={previewStyles}>
      <div className="flex-1 space-y-6">
        {loadError && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{loadError}</div>
        )}

        <div>
          <h2 className="text-xl font-medium text-white mb-2">Base Themes</h2>
          <p className="text-sm text-zinc-400 mb-4">
            Pick the daisyUI theme each mode starts from. Your site's daisyUI build must include both themes, for example{' '}
            <code className="text-zinc-300">@plugin "daisyui" {'{'} themes: light --default, dark --prefersdark; {'}'}</code>.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-2">Light Theme</label>
              <select
                className="w-full bg-black/30 border border-white/10 text-zinc-200 text-sm focus:outline-none focus:ring-1 ring-indigo-500 rounded px-3 py-2"
                value={lightTheme}
                onChange={(e) => handleThemeChange('light', e.target.value)}
              >
                {themeOptions('light', lightTheme)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-2">Dark Theme</label>
              <select
                className="w-full bg-black/30 border border-white/10 text-zinc-200 text-sm focus:outline-none focus:ring-1 ring-indigo-500 rounded px-3 py-2"
                value={darkTheme}
                onChange={(e) => handleThemeChange('dark', e.target.value)}
              >
                {themeOptions('dark', darkTheme)}
              </select>
            </div>
          </div>
        </div>

        <div className="pt-6 border-t border-white/10">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h2 className="text-xl font-medium text-white">Color Palette</h2>
              <p className="text-sm text-zinc-400">
                Override colours of the {editMode} theme (<span className="text-zinc-300">{editTheme}</span>). Empty fields use the theme's own colour, shown in grey, and are not saved.
              </p>
            </div>
            <div className="flex bg-black/30 p-1 rounded-lg border border-white/10 shrink-0">
              <button
                onClick={() => setEditMode('light')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${editMode === 'light' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                Light Colors
              </button>
              <button
                onClick={() => setEditMode('dark')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${editMode === 'dark' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                Dark Colors
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={handleResetColors}
            disabled={editOverrideCount === 0}
            className="text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
          >
            Reset all {editMode} colours to {editTheme}{editOverrideCount > 0 ? ` (${editOverrideCount} overridden)` : ''}
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {DAISYUI_THEME_COLORS.map((color) => {
            const override = editColors[color.key];
            const inherited = baseValue(editTheme, editMode, color.key);
            const invalid = isInvalidColor(override);
            const shown = override !== undefined && !invalid ? normalizeColorInput(override) : inherited;
            const inputId = `daisyui-${editMode}-${color.key}`;
            return (
              <div key={color.key} className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-lg p-3">
                <label className="relative w-10 h-10 shrink-0 cursor-pointer" title={`Pick ${color.label}`}>
                  <span
                    className="block w-full h-full rounded-full shadow-inner border border-white/20"
                    style={{ backgroundColor: shown }}
                  />
                  <input
                    type="color"
                    aria-label={`${color.label} colour picker`}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    value={colorToHex(shown) ?? '#000000'}
                    onChange={(e) => handleColorChange(color.key, e.target.value)}
                  />
                </label>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <label htmlFor={inputId} className="block text-xs font-semibold text-zinc-300 uppercase tracking-wider">
                      {color.label}
                    </label>
                    {override !== undefined && (
                      <button
                        type="button"
                        onClick={() => handleColorChange(color.key, '')}
                        className="text-[11px] text-zinc-400 hover:text-zinc-200"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                  <input
                    id={inputId}
                    type="text"
                    spellCheck={false}
                    aria-invalid={invalid}
                    className={`w-full bg-black/30 border rounded px-2 py-1.5 text-zinc-200 text-sm font-mono placeholder:text-zinc-500 focus:outline-none focus:ring-2 ${invalid ? 'border-red-500/50 focus:ring-red-500/50' : 'border-white/10 focus:ring-indigo-500/50'}`}
                    value={override ?? ''}
                    placeholder={inherited}
                    onChange={(e) => handleColorChange(color.key, e.target.value)}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <div className="pt-6 border-t border-white/10">
          <h2 className="text-xl font-medium text-white mb-2">Advanced Config</h2>
          <p className="text-sm text-zinc-400 mb-6">
            daisyUI's radius, size, border and effect variables, applied to both themes. Empty fields keep each theme's own value, shown in grey.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {DAISYUI_THEME_ADVANCED.map((item) => {
              const override = advanced[item.key];
              const invalid = isInvalidNumber(override);
              return (
                <div key={item.key} className="flex flex-col bg-white/5 border border-white/10 rounded-lg p-3">
                  <label htmlFor={`daisyui-advanced-${item.key}`} className="block text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-2">
                    {item.label}
                  </label>
                  <div className={`flex bg-black/30 border rounded overflow-hidden focus-within:ring-2 ${invalid ? 'border-red-500/50 focus-within:ring-red-500/50' : 'border-white/10 focus-within:ring-indigo-500/50'}`}>
                    <input
                      id={`daisyui-advanced-${item.key}`}
                      type="text"
                      spellCheck={false}
                      aria-invalid={invalid}
                      className="bg-transparent border-none text-zinc-200 text-sm placeholder:text-zinc-500 focus:outline-none w-full px-3 py-1.5"
                      value={override ?? ''}
                      placeholder={advancedPlaceholder(item.key)}
                      onChange={(e) => handleAdvancedChange(item.key, e.target.value)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="pt-4 flex items-center gap-4 border-t border-white/10 mt-6">
          <button
            onClick={handleSave}
            disabled={isSaving || !!loadError || invalidFields.length > 0}
            className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-medium transition-colors disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : 'Save Theme'}
          </button>
          {success && <span className="text-sm text-emerald-400 font-medium">Theme saved successfully!</span>}
          {invalidFields.length > 0 && (
            <span className="text-sm text-red-300">Fix the highlighted values before saving ({invalidFields.join(', ')}).</span>
          )}
        </div>
      </div>

      <div className="w-full lg:w-96 shrink-0 space-y-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Mini Preview</h3>
          <div className="flex bg-black/30 p-1 rounded border border-white/10">
            <button
              onClick={() => setPreviewMode('light')}
              className={`px-2 py-1 text-[10px] font-bold uppercase rounded-sm transition-colors ${previewMode === 'light' ? 'bg-zinc-200 text-black' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              Light
            </button>
            <button
              onClick={() => setPreviewMode('dark')}
              className={`px-2 py-1 text-[10px] font-bold uppercase rounded-sm transition-colors ${previewMode === 'dark' ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              Dark
            </button>
          </div>
        </div>
        <div
          className="overflow-hidden shadow-2xl border border-white/10"
          style={{ borderRadius: radiusBox }}
        >
          <div className="p-6 space-y-6 pb-8" style={{ backgroundColor: 'var(--preview-b1)' }}>
            <div className="space-y-2">
              <h4 style={{ color: 'var(--preview-p)' }} className="text-xl font-bold">Primary Heading</h4>
              <p style={{ color: 'var(--preview-bc)' }} className="text-sm font-medium opacity-80">This text uses the base content color on base-100.</p>
            </div>

            <div className="flex gap-2">
              {[
                ['Primary', 'p', 'pc'],
                ['Secondary', 's', 'sc'],
                ['Accent', 'a', 'ac'],
              ].map(([label, background, content]) => (
                <button
                  key={label}
                  className="px-4 py-2 text-sm font-bold border"
                  style={{
                    backgroundColor: `var(--preview-${background})`,
                    color: `var(--preview-${content})`,
                    borderRadius: radiusField,
                    borderWidth,
                    borderColor: `var(--preview-${background})`
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="flex gap-4">
               <div
                 className="w-full flex-1 p-4 font-medium text-sm flex items-center justify-center border"
                 style={{
                   backgroundColor: 'var(--preview-b2)',
                   color: 'var(--preview-bc)',
                   borderColor: 'var(--preview-b3)',
                   borderWidth,
                   borderRadius: radiusBox,
                 }}
               >
                 Base 200 Card
               </div>
            </div>

            <div className="flex gap-2 text-xs">
              <span
                className="px-2 py-1"
                style={{
                  backgroundColor: 'var(--preview-suc)',
                  color: 'var(--preview-succ)',
                  borderRadius: radiusSelector,
                }}
              >
                Success
              </span>
              <span
                className="px-2 py-1"
                style={{
                  backgroundColor: 'var(--preview-err)',
                  color: 'var(--preview-errc)',
                  borderRadius: radiusSelector,
                }}
              >
                Error
              </span>
            </div>
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-white/10">
          <p className="text-sm text-zinc-400 mb-4">Want to see the full component library styled with this theme?</p>

          {layoutOptions.length > 0 && (
            <div className="mb-4">
              <label className="block text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-2">Host Layout Override</label>
              <select
                className="w-full bg-black/30 border border-white/10 text-zinc-200 text-sm focus:outline-none focus:ring-1 ring-indigo-500 rounded px-3 py-2"
                value={selectedLayout}
                onChange={(e) => setSelectedLayout(e.target.value)}
              >
                <option value="">Default (No Layout)</option>
                {layoutOptions.map(layout => (
                  <option key={layout} value={layout}>{layout}</option>
                ))}
              </select>
            </div>
          )}

          <button
            onClick={handleOpenPreview}
            className="flex w-full items-center justify-center gap-2 px-5 py-3 bg-white/5 hover:bg-white/10 border border-white/10 text-white rounded-lg font-medium transition-colors cursor-pointer"
          >
            Open Full Preview <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
          </button>
        </div>
      </div>
    </div>
  );
}
