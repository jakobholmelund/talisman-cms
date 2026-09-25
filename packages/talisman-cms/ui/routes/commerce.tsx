import React from 'react';
import { Outlet, createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/commerce')({
  component: CommerceLayout,
});

function CommerceLayout() {
  return <Outlet />;
}
