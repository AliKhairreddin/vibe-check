import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  RouterProvider,
} from '@tanstack/react-router';

import { ClientDashboardPage, ClientReviewDetailPage } from '@/components/client-dashboard';
import { TooltipProvider } from '@/components/ui/tooltip';

const queryClient = new QueryClient();

function ClientLayout() {
  return <Outlet />;
}

const rootRoute = createRootRoute({ component: ClientLayout });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/login' });
  },
});
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: ClientDashboardPage,
});
const clientRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/client',
  component: ClientDashboardPage,
});
const clientReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/client/$clientId/reviews/$jobId',
  component: ClientReviewDetailPage,
});
const legacyKissterraRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/kissterra',
  beforeLoad: () => {
    throw redirect({ to: '/client' });
  },
});
const legacyKissterraReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/kissterra/reviews/$jobId',
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/client/$clientId/reviews/$jobId',
      params: { clientId: 'kissterra', jobId: params.jobId },
    });
  },
});

const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    loginRoute,
    clientRoute,
    clientReviewRoute,
    legacyKissterraRoute,
    legacyKissterraReviewRoute,
  ]),
});

let clientRoot: Root | undefined;

export function mountClientApp(element: HTMLElement) {
  document.title = 'Sign in · AdChecked';
  clientRoot ??= createRoot(element);
  clientRoot.render(
    <TooltipProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </TooltipProvider>,
  );
}
