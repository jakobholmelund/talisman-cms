import React from 'react';
import { Outlet, createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/collections')({
  component: CollectionsLayout,
});

function CollectionsLayout() {
  return <Outlet />;
}
