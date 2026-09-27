import { Hono } from 'hono';
import { AppEnv } from './common';
import { registerEvergreenRoutes } from './evergreen';

// Routes anyone can use without signing in. Only the evergreen explainer
// videos ("Brain Science", "How It Works") are here, so the home page can
// play them; procedure videos stay behind a doctor or patient sign-in.
export const publicRoutes = new Hono<AppEnv>();

registerEvergreenRoutes(publicRoutes, '/evergreen');
