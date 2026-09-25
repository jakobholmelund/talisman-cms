import React from 'react';
import { Outlet, createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/globals')({
  component: GlobalsLayoutRoute,
});

function GlobalsLayoutRoute() {
  return <Outlet />;
}
