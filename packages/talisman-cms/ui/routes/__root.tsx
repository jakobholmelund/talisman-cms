import React, { useState } from 'react';
import { Outlet, createRootRouteWithContext, Link, useRouter } from '@tanstack/react-router';
import { Database, FileText, Globe, Home, ImageIcon, Layers, LogOut, ShoppingCart, UserRound, Users } from 'lucide-react';
import type { RouterContext } from '../routerContext';
import { canOpenAdminExtension, getReadableSectionCollections, hasMediaCollection, hasPagesCollection, hasSection } from '../lib/admin-sections';
import { AuthPanel } from '../components/AuthPanel';
// @ts-ignore
import { adminExtensions } from 'virtual:talisman-cms/admin-extensions';
import '../globals.css';

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => {
    const { context } = useRouter().options;
    const [signOutError, setSignOutError] = useState('');
    const isAdmin = context.user?.role === 'admin';
    const hasCommerce = isAdmin && hasSection('commerce');
    // Editors skip the Commerce workspace (its tools are admin-only) and get the commerce content they may edit,
    // opened under /collections so its back links never lead into that workspace.
    const editorCommerceCollections = context.user && !isAdmin ? getReadableSectionCollections('commerce', context.user) : [];
    const sidebarExtensions = adminExtensions.filter((ext: any) => ext.section !== 'commerce' && canOpenAdminExtension(ext, context.user));
    const hasMedia = hasMediaCollection();
    const hasPages = hasPagesCollection();
    // Hybrid admins sign in through Cloudflare Access, so signing out must end that session as well.
    const endsAccessSession = context.isHybridAuth && isAdmin;
    
    if (!context.user) return context.isAccessAuth
      ? <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center gap-4 px-4 text-zinc-100"><p>Cloudflare Access has not authorized this CMS account.</p><a href="/cdn-cgi/access/logout" className="text-sm text-indigo-300 hover:text-indigo-200">Sign out of Cloudflare Access</a></div>
      : <AuthPanel adminBasePath={context.adminBasePath} isHybridAuth={context.isHybridAuth} />;

    async function signOut() {
      if (context.isAccessAuth) {
        window.location.assign('/cdn-cgi/access/logout');
        return;
      }
      setSignOutError('');
      const response = await fetch(`${context.adminBasePath}/api/auth/sign-out`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}'
      }).catch(() => null);
      // 401 means the CMS session had already ended.
      if (!response || (!response.ok && response.status !== 401)) {
        setSignOutError('Sign out failed. Try again.');
        return;
      }
      if (endsAccessSession) {
        window.location.assign('/cdn-cgi/access/logout');
        return;
      }
      window.location.reload();
    }

    return (
    <div className="min-h-screen bg-transparent text-zinc-50 font-sans selection:bg-indigo-500/30">
      <div className="flex h-screen overflow-hidden">
        {/* Sidebar */}
        <aside className="w-64 shrink-0 border-r border-white/10 bg-zinc-950/80 backdrop-blur-2xl hidden md:flex flex-col z-20">
          <div className="flex items-center h-16 px-6 border-b border-white/10 bg-white/[0.02]">
            <div className="flex items-center gap-3">
               <div className="p-1.5 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-lg shadow-lg shadow-indigo-500/20">
                 <Layers className="text-white" size={16} />
               </div>
               <span className="font-semibold text-sm tracking-wide bg-gradient-to-br from-white to-zinc-400 bg-clip-text text-transparent">Talisman CMS</span>
            </div>
          </div>
          <nav className="flex-1 p-4 space-y-1">
             <div className="text-[10px] text-zinc-500 uppercase font-bold tracking-widest mb-3 px-3 mt-2">Overview</div>
             <Link to="/" className="flex items-center gap-3 px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 hover:bg-white/5 rounded-lg transition-all duration-200 [&.active]:bg-indigo-500/15 [&.active]:text-indigo-300 [&.active]:font-medium [&.active]:shadow-[inset_2px_0_0_0_theme(colors.indigo.500)]">
               <Home size={16} className="opacity-70" /> Dashboard
             </Link>
             
             <div className="text-[10px] text-zinc-500 uppercase font-bold tracking-widest mb-3 px-3 mt-6">Content</div>
             {hasPages && (
               <Link
                 to="/collections/$slug"
                 params={{ slug: 'pages' }}
                 className="flex items-center gap-3 px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 hover:bg-white/5 rounded-lg transition-all duration-200 [&.active]:bg-indigo-500/15 [&.active]:text-indigo-300 [&.active]:font-medium [&.active]:shadow-[inset_2px_0_0_0_theme(colors.indigo.500)]"
               >
                 <FileText size={16} className="opacity-70" /> Pages
               </Link>
             )}
             <Link to="/collections" className="flex items-center gap-3 px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 hover:bg-white/5 rounded-lg transition-all duration-200 [&.active]:bg-indigo-500/15 [&.active]:text-indigo-300 [&.active]:font-medium [&.active]:shadow-[inset_2px_0_0_0_theme(colors.indigo.500)]">
               <Database size={16} className="opacity-70" /> Collections
             </Link>
             {hasMedia && (
               <Link to="/media" className="flex items-center gap-3 px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 hover:bg-white/5 rounded-lg transition-all duration-200 [&.active]:bg-indigo-500/15 [&.active]:text-indigo-300 [&.active]:font-medium [&.active]:shadow-[inset_2px_0_0_0_theme(colors.indigo.500)]">
                 <ImageIcon size={16} className="opacity-70" /> Media
               </Link>
             )}
             {hasCommerce && (
               <Link to="/commerce" className="flex items-center gap-3 px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 hover:bg-white/5 rounded-lg transition-all duration-200 [&.active]:bg-indigo-500/15 [&.active]:text-indigo-300 [&.active]:font-medium [&.active]:shadow-[inset_2px_0_0_0_theme(colors.indigo.500)]">
                 <ShoppingCart size={16} className="opacity-70" /> Commerce
               </Link>
             )}
             {editorCommerceCollections.map((collection) => (
               <Link key={collection.slug} to="/collections/$slug" params={{ slug: collection.slug }} className="flex items-center gap-3 px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 hover:bg-white/5 rounded-lg transition-all duration-200 [&.active]:bg-indigo-500/15 [&.active]:text-indigo-300 [&.active]:font-medium [&.active]:shadow-[inset_2px_0_0_0_theme(colors.indigo.500)]">
                 <ShoppingCart size={16} className="opacity-70" /> {collection.name}
               </Link>
             ))}
             <Link to="/globals" className="flex items-center gap-3 px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 hover:bg-white/5 rounded-lg transition-all duration-200 [&.active]:bg-indigo-500/15 [&.active]:text-indigo-300 [&.active]:font-medium [&.active]:shadow-[inset_2px_0_0_0_theme(colors.indigo.500)]">
               <Globe size={16} className="opacity-70" /> Globals
             </Link>
             {!context.isDevAuth && !context.isAccessAuth && context.user.role === 'admin' && <Link to="/users" className="flex items-center gap-3 px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 hover:bg-white/5 rounded-lg [&.active]:bg-indigo-500/15 [&.active]:text-indigo-300"><Users size={16} /> Users</Link>}
             {!context.isDevAuth && !context.isAccessAuth && <Link to="/account" className="flex items-center gap-3 px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 hover:bg-white/5 rounded-lg [&.active]:bg-indigo-500/15 [&.active]:text-indigo-300"><UserRound size={16} /> Account</Link>}

             {sidebarExtensions.length > 0 && (
               <>
                 <div className="text-[10px] text-zinc-500 uppercase font-bold tracking-widest mb-3 px-3 mt-6">Extensions</div>
                 {sidebarExtensions.map((ext: any) => (
                   <Link key={ext.path} to="/extensions/$extensionPath" params={{ extensionPath: ext.path }} className="flex items-center gap-3 px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 hover:bg-white/5 rounded-lg transition-all duration-200 [&.active]:bg-indigo-500/15 [&.active]:text-indigo-300 [&.active]:font-medium [&.active]:shadow-[inset_2px_0_0_0_theme(colors.indigo.500)]">
                     <Layers size={16} className="opacity-70" /> {ext.label}
                   </Link>
                 ))}
               </>
             )}
          </nav>
        </aside>

        {/* Main Application Area */}
        <main className="flex-1 overflow-y-auto relative bg-transparent flex flex-col">
          <header className="h-16 shrink-0 border-b border-white/10 bg-zinc-950/80 backdrop-blur-2xl sticky top-0 z-10 flex items-center px-8 shadow-sm">
            <h2 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
               Menu
             </h2>
             <div className="ml-auto flex items-center gap-4 text-xs text-zinc-400">{signOutError && <span role="alert" className="text-red-400">{signOutError}</span>}<span>{context.user.email}</span>{!context.isDevAuth && <button onClick={signOut} title={endsAccessSession ? 'Ends your CMS session and your Cloudflare Access session' : undefined} className="flex items-center gap-1 hover:text-white"><LogOut size={14} /> {endsAccessSession ? 'Sign out of CMS and Cloudflare' : 'Sign out'}</button>}</div>
          </header>
          <div className="p-8 md:p-12 w-full flex-1">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
    );
  },
});
