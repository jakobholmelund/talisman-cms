import React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Card } from '../../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Button } from '../../components/ui/button';
import { Globe, MoreHorizontal, Plus } from 'lucide-react';

type GlobalListItem = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
};

export const Route = createFileRoute('/globals/')({
  component: GlobalsIndexRoute,
  loader: async ({ context }) => {
    const adminBasePath = context.adminBasePath || '/admin';
    const res = await fetch(`${adminBasePath}/api/globals`);
    if (!res.ok) throw new Error('Failed to fetch globals');
    return res.json() as Promise<GlobalListItem[]>;
  }
});

function GlobalsIndexRoute() {
  const globals = Route.useLoaderData();
  const routeContext = Route.useRouteContext();
  const adminBasePath = routeContext.adminBasePath || '/admin';
  // Creating a global is admin-only on the server; editors edit the existing ones.
  const canCreateGlobal = routeContext.user?.role === 'admin';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Globals</h1>
          <p className="text-zinc-400 mt-1">Manage global site settings and single-document singletons.</p>
        </div>
        {canCreateGlobal ? (
          <Button
            type="button"
            className="gap-2"
            onClick={() => {
              window.location.assign(`${adminBasePath}/globals/new`);
            }}
          >
            <Plus size={16} /> New Global
          </Button>
        ) : null}
      </div>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader className="bg-zinc-900/50">
            <TableRow>
              <TableHead className="w-[300px]">Name</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead className="text-right">Created</TableHead>
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {globals.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-zinc-500 py-8">
                  No globals defined yet.
                </TableCell>
              </TableRow>
            ) : (
              globals.map((glb) => (
                <TableRow
                  key={glb.id}
                  className="cursor-pointer hover:bg-white/5 transition-colors"
                  onClick={() => {
                    window.location.assign(`${adminBasePath}/globals/${glb.slug}`);
                  }}
                >
                  <TableCell className="font-medium">
                    <a href={`${adminBasePath}/globals/${glb.slug}`} className="flex items-center gap-3">
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-zinc-900 text-zinc-400">
                        <Globe size={14} />
                      </span>
                      <div>
                        <div>{glb.name}</div>
                        {glb.description ? <div className="text-xs font-normal text-zinc-500">{glb.description}</div> : null}
                      </div>
                    </a>
                  </TableCell>
                  <TableCell>
                    <a href={`${adminBasePath}/globals/${glb.slug}`}>
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono bg-zinc-800 text-zinc-400 border border-zinc-700">
                        {glb.slug}
                      </span>
                    </a>
                  </TableCell>
                  <TableCell className="text-right text-zinc-400">
                    {new Date(glb.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label={`Edit ${glb.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        window.location.assign(`${adminBasePath}/globals/${glb.slug}`);
                      }}
                    >
                        <MoreHorizontal size={14} aria-hidden="true" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
