import React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

export const Route = createFileRoute('/')({
  component: Index,
});

function Index() {
  return (
    <div className="space-y-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight text-white">Overview</h1>
        <p className="text-zinc-400 mt-2 text-sm leading-relaxed max-w-2xl">Welcome to your highly optimized Cloudflare CMS. Monitor your project's content and performance metrics below.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="group relative overflow-hidden transition-all duration-300 hover:shadow-xl hover:shadow-indigo-500/10 hover:-translate-y-0.5 border-white/5 bg-gradient-to-br from-white/[0.03] to-white/[0.01]">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-indigo-500/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-zinc-400 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-indigo-500/50" />
              Total Posts
            </CardTitle>
          </CardHeader>
          <CardContent>
             <div className="text-4xl font-semibold tracking-tight text-white group-hover:text-indigo-50 transition-colors">--</div>
          </CardContent>
        </Card>
        <Card className="group relative overflow-hidden transition-all duration-300 hover:shadow-xl hover:shadow-purple-500/10 hover:-translate-y-0.5 border-white/5 bg-gradient-to-br from-white/[0.03] to-white/[0.01]">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-purple-500/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-zinc-400 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-purple-500/50" />
              Media Assets
            </CardTitle>
          </CardHeader>
          <CardContent>
             <div className="text-4xl font-semibold tracking-tight text-white group-hover:text-purple-50 transition-colors">--</div>
          </CardContent>
        </Card>
        <Card className="group relative overflow-hidden transition-all duration-300 hover:shadow-xl hover:shadow-emerald-500/10 hover:-translate-y-0.5 border-white/5 bg-gradient-to-br from-white/[0.03] to-white/[0.01]">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-500/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-zinc-400 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500/50" />
              Cache Hit Rate (KV)
            </CardTitle>
          </CardHeader>
          <CardContent>
             <div className="text-4xl font-semibold tracking-tight text-emerald-400 group-hover:text-emerald-300 transition-colors">--</div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
