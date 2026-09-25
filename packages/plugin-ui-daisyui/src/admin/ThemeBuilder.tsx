import React, { useEffect, useState } from 'react';
import { DAISYUI_THEME_DEFAULTS } from './themeDefaults';

const DAISYUI_COLORS = [
  { id: 'primary', label: 'Primary', default: '#570df8' },
  { id: 'primary-content', label: 'Primary Content', default: '#ffffff' },
  { id: 'secondary', label: 'Secondary', default: '#f000b8' },
  { id: 'secondary-content', label: 'Secondary Content', default: '#ffffff' },
  { id: 'accent', label: 'Accent', default: '#1dcdbc' },
  { id: 'accent-content', label: 'Accent Content', default: '#ffffff' },
  { id: 'neutral', label: 'Neutral', default: '#2b3440' },
  { id: 'neutral-content', label: 'Neutral Content', default: '#ffffff' },
  { id: 'base-100', label: 'Base 100', default: '#ffffff' },
  { id: 'base-200', label: 'Base 200', default: '#f2f2f2' },
  { id: 'base-300', label: 'Base 300', default: '#e5e6e6' },
  { id: 'base-content', label: 'Base Content', default: '#1f2937' },
  { id: 'info', label: 'Info', default: '#3abff8' },
  { id: 'info-content', label: 'Info Content', default: '#002b3d' },
  { id: 'success', label: 'Success', default: '#36d399' },
  { id: 'success-content', label: 'Success Content', default: '#003320' },
  { id: 'warning', label: 'Warning', default: '#fbbd23' },
  { id: 'warning-content', label: 'Warning Content', default: '#382800' },
  { id: 'error', label: 'Error', default: '#f87272' },
  { id: 'error-content', label: 'Error Content', default: '#470000' },
];

const DAISYUI_ADVANCED = [
  { id: 'rounded-box', label: 'Border Radius (Cards & Modals)', default: '1rem' },
  { id: 'rounded-btn', label: 'Border Radius (Buttons)', default: '0.5rem' },
  { id: 'rounded-badge', label: 'Border Radius (Badges)', default: '1.9rem' },
  { id: 'animation-btn', label: 'Animation Duration (Buttons)', default: '0.25s' },
  { id: 'animation-input', label: 'Animation Duration (Inputs)', default: '0.2s' },
  { id: 'btn-focus-scale', label: 'Button Focus Scale', default: '0.95' },
  { id: 'border-btn', label: 'Button Border Width', default: '1px' },
  { id: 'tab-border', label: 'Tab Border Width', default: '1px' },
  { id: 'tab-radius', label: 'Tab Border Radius', default: '0.5rem' },
];

export default function ThemeBuilder() {
  const [lightColors, setLightColors] = useState<Record<string, string>>({});
  const [darkColors, setDarkColors] = useState<Record<string, string>>({});
  const [lightTheme, setLightTheme] = useState('light');
  const [darkTheme, setDarkTheme] = useState('dark');
  const [editMode, setEditMode] = useState<'light' | 'dark'>('light');
  const [previewMode, setPreviewMode] = useState<'light' | 'dark'>('light');
  const [advanced, setAdvanced] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(true);
  const [layoutOptions, setLayoutOptions] = useState<string[]>([]);
  const [selectedLayout, setSelectedLayout] = useState<string>('');

  useEffect(() => {
    // Determine admin base path from URL pattern /admin/...
    const pathParts = window.location.pathname.split('/');
    const basePath = pathParts[1] === 'extensions' ? '' : `/${pathParts[1]}`;
    const apiPath = `${basePath}/api/daisyui/theme`;
    const layoutsApiPath = `${basePath}/api/daisyui/layouts`;
    
    Promise.all([
      fetch(apiPath).then((res) => res.json()).catch(() => ({})),
      fetch(layoutsApiPath).then((res) => res.json()).catch(() => ({ layouts: [] }))
    ])
      .then(([data, layoutsData]) => {
        if (data) {
          if (data.lightTheme) setLightTheme(data.lightTheme);
          if (data.darkTheme) setDarkTheme(data.darkTheme);
          
          if (data.lightColors) setLightColors(data.lightColors);
          else {
            const defaults: Record<string, string> = {};
            for (const color of DAISYUI_COLORS) defaults[color.id] = color.default;
            setLightColors(defaults);
          }

          if (data.darkColors) setDarkColors(data.darkColors);
          else {
            const defaults: Record<string, string> = {};
            for (const color of DAISYUI_COLORS) defaults[color.id] = color.default;
            setDarkColors(defaults);
          }
        }
        if (data && data.advanced) {
          setAdvanced(data.advanced);
        } else {
          const advDefaults: Record<string, string> = {};
          for (const item of DAISYUI_ADVANCED) {
            advDefaults[item.id] = item.default;
          }
          setAdvanced(advDefaults);
        }

        if (layoutsData && layoutsData.layouts) {
          setLayoutOptions(layoutsData.layouts);
          setSelectedLayout(layoutsData.layouts[0] || '');
        }
      })
      .catch((err) => console.error('Failed to fetch theme or layouts:', err))
      .finally(() => setLoading(false));
  }, []);

  const handleThemeChange = (mode: 'light' | 'dark', themeName: string) => {
    const defaultVals = DAISYUI_THEME_DEFAULTS[themeName];
    if (!defaultVals) return;

    // Pick out just the colors
    const colorsObj: Record<string, string> = {};
    for (const color of DAISYUI_COLORS) {
      if (defaultVals[color.id]) {
        colorsObj[color.id] = defaultVals[color.id];
      }
    }

    if (mode === 'light') {
      setLightTheme(themeName);
      setLightColors((prev) => ({ ...prev, ...colorsObj }));
    } else {
      setDarkTheme(themeName);
      setDarkColors((prev) => ({ ...prev, ...colorsObj }));
    }
  };

  const handleColorChange = (id: string, value: string) => {
    if (editMode === 'light') {
      setLightColors((prev) => ({ ...prev, [id]: value }));
    } else {
      setDarkColors((prev) => ({ ...prev, [id]: value }));
    }
  };
  const handleAdvancedChange = (id: string, value: string) => {
    setAdvanced((prev) => ({ ...prev, [id]: value }));
  };

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
        body: JSON.stringify({ 
          lightTheme, darkTheme, lightColors, darkColors, advanced 
        }),
      });
      
      if (res.ok) {
        setSuccess(true);
        setTimeout(() => setSuccess(false), 3000);
      } else {
        throw new Error('Failed to save');
      }
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

  const previewColors = previewMode === 'light' ? lightColors : darkColors;
  const editColors = editMode === 'light' ? lightColors : darkColors;

  const handleOpenPreview = () => {
    const previewState = { lightTheme, darkTheme, lightColors, darkColors, advanced };
    sessionStorage.setItem('daisyui-preview-state', JSON.stringify(previewState));
    const url = `/admin/daisyui-preview?mode=${previewMode}${selectedLayout ? `&layout=${encodeURIComponent(selectedLayout)}` : ''}`;
    window.open(url, '_blank');
  };

  // Mini preview generated via style injected safely
  const previewStyles = {
    '--preview-p': previewColors['primary'] || '#570df8',
    '--preview-s': previewColors['secondary'] || '#f000b8',
    '--preview-a': previewColors['accent'] || '#1dcdbc',
    '--preview-n': previewColors['neutral'] || '#2b3440',
    '--preview-b1': previewColors['base-100'] || '#ffffff',
    '--preview-b2': previewColors['base-200'] || '#f2f2f2',
    '--preview-b3': previewColors['base-300'] || '#e5e6e6',
    '--preview-suc': previewColors['success'] || '#36d399',
    '--preview-err': previewColors['error'] || '#f87272',
  } as React.CSSProperties;

  const DAISYUI_THEMES = [
    "light", "dark", "cupcake", "bumblebee", "emerald", "corporate", "synthwave", "retro", 
    "cyberpunk", "valentine", "halloween", "garden", "forest", "aqua", "lofi", "pastel", 
    "fantasy", "wireframe", "black", "luxury", "dracula", "cmyk", "autumn", "business", 
    "acid", "lemonade", "night", "coffee", "winter", "dim", "nord", "sunset"
  ];

  return (
    <div className="flex flex-col lg:flex-row gap-8 p-6" style={previewStyles}>
      <div className="flex-1 space-y-6">
        <div>
          <h2 className="text-xl font-medium text-white mb-2">Base Themes</h2>
          <p className="text-sm text-zinc-400 mb-4">
            Select the default DaisyUI background patterns and baseline colors for each mode.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-2">Light Theme</label>
              <select 
                className="w-full bg-black/30 border border-white/10 text-zinc-200 text-sm focus:outline-none focus:ring-1 ring-indigo-500 rounded px-3 py-2"
                value={lightTheme}
                onChange={(e) => handleThemeChange('light', e.target.value)}
              >
                {DAISYUI_THEMES
                  .filter(t => DAISYUI_THEME_DEFAULTS[t]?.colorScheme === 'light')
                  .map(t => <option key={t} value={t}>{t} (Light)</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-2">Dark Theme</label>
              <select 
                className="w-full bg-black/30 border border-white/10 text-zinc-200 text-sm focus:outline-none focus:ring-1 ring-indigo-500 rounded px-3 py-2"
                value={darkTheme}
                onChange={(e) => handleThemeChange('dark', e.target.value)}
              >
                {DAISYUI_THEMES
                  .filter(t => DAISYUI_THEME_DEFAULTS[t]?.colorScheme === 'dark')
                  .map(t => <option key={t} value={t}>{t} (Dark)</option>)}
              </select>
            </div>
          </div>
        </div>

        <div className="pt-6 border-t border-white/10">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h2 className="text-xl font-medium text-white">Color Palette</h2>
              <p className="text-sm text-zinc-400">
                Override specific colors for the selected mode.
              </p>
            </div>
            <div className="flex bg-black/30 p-1 rounded-lg border border-white/10">
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
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {DAISYUI_COLORS.map((color) => {
            const val = editColors[color.id] || color.default;
            return (
              <div key={color.id} className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-lg p-3">
                <div 
                  className="w-10 h-10 rounded-full shadow-inner border border-white/20 shrink-0" 
                  style={{ backgroundColor: val }}
                />
                <div className="flex-1">
                  <label className="block text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-1">
                    {color.label}
                  </label>
                  <div className="flex bg-black/30 rounded focus-within:ring-1 ring-indigo-500 overflow-hidden">
                    <span className="text-zinc-500 text-xs px-2 py-1.5 font-mono select-none">#</span>
                    <input
                      type="text"
                      className="bg-transparent border-none text-zinc-200 text-sm font-mono focus:outline-none w-full"
                      value={val.replace(/^#/, '')}
                      onChange={(e) => handleColorChange(color.id, '#' + e.target.value)}
                    />
                  </div>
                </div>
                <input
                  type="color"
                  className="w-10 h-10 opacity-0 cursor-pointer absolute right-5"
                  value={val}
                  onChange={(e) => handleColorChange(color.id, e.target.value)}
                />
              </div>
            );
          })}
        </div>
        
        <div className="pt-6 border-t border-white/10">
          <h2 className="text-xl font-medium text-white mb-2">Advanced Config</h2>
          <p className="text-sm text-zinc-400 mb-6">
            Modify structural variables like border radiuses, animation durations, and padding values.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {DAISYUI_ADVANCED.map((item) => {
              const val = advanced[item.id] || item.default;
              return (
                <div key={item.id} className="flex flex-col bg-white/5 border border-white/10 rounded-lg p-3">
                  <label className="block text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-2">
                    {item.label}
                  </label>
                  <div className="flex bg-black/30 rounded focus-within:ring-1 ring-indigo-500 overflow-hidden">
                    <input
                      type="text"
                      className="bg-transparent border-none text-zinc-200 text-sm focus:outline-none w-full px-3 py-1.5"
                      value={val}
                      onChange={(e) => handleAdvancedChange(item.id, e.target.value)}
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
            disabled={isSaving}
            className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-medium transition-colors disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : 'Save Theme'}
          </button>
          {success && <span className="text-sm text-emerald-400 font-medium">Theme saved successfully!</span>}
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
          style={{ borderRadius: advanced['rounded-box'] || '1rem' }}
        >
          <div className="p-6 space-y-6 pb-8" style={{ backgroundColor: 'var(--preview-b1)' }}>
            <div className="space-y-2">
              <h4 style={{ color: 'var(--preview-p)' }} className="text-xl font-bold">Primary Heading</h4>
              <p style={{ color: 'var(--preview-n)' }} className="text-sm font-medium opacity-80">This text uses the neutral color for contrast against base-100.</p>
            </div>
            
            <div className="flex gap-2">
              <button 
                className="px-4 py-2 text-sm font-bold border"
                style={{ 
                  backgroundColor: 'var(--preview-p)', 
                  color: 'var(--preview-b1)',
                  borderRadius: advanced['rounded-btn'] || '0.5rem',
                  borderWidth: advanced['border-btn'] || '1px',
                  borderColor: 'var(--preview-p)'
                }}
              >
                Primary
              </button>
              <button 
                className="px-4 py-2 text-sm font-bold border"
                style={{ 
                  backgroundColor: 'var(--preview-s)', 
                  color: 'var(--preview-b1)',
                  borderRadius: advanced['rounded-btn'] || '0.5rem',
                  borderWidth: advanced['border-btn'] || '1px',
                  borderColor: 'var(--preview-s)'
                }}
              >
                Secondary
              </button>
              <button 
                className="px-4 py-2 text-sm font-bold border"
                style={{ 
                  backgroundColor: 'var(--preview-a)', 
                  color: 'var(--preview-b1)',
                  borderRadius: advanced['rounded-btn'] || '0.5rem',
                  borderWidth: advanced['border-btn'] || '1px',
                  borderColor: 'var(--preview-a)'
                }}
              >
                Accent
              </button>
            </div>
            
            <div className="flex gap-4">
               <div 
                 className="w-full flex-1 p-4 font-medium text-sm flex items-center justify-center border" 
                 style={{ 
                   backgroundColor: 'var(--preview-b2)', 
                   color: 'var(--preview-n)', 
                   borderColor: 'var(--preview-b3)',
                   borderRadius: advanced['rounded-box'] || '1rem',
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
                  color: 'var(--preview-b1)',
                  borderRadius: advanced['rounded-badge'] || '1.9rem',
                }}
              >
                Success
              </span>
              <span 
                className="px-2 py-1" 
                style={{ 
                  backgroundColor: 'var(--preview-err)', 
                  color: 'var(--preview-b1)',
                  borderRadius: advanced['rounded-badge'] || '1.9rem',
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
