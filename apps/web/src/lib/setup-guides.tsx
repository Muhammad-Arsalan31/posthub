import { Anchor } from '@mantine/core';
import type { Provider } from '@posthub/contract';
import type { ReactNode } from 'react';

/**
 * Step-by-step connect instructions per provider, shown by the setup guide on the Accounts page.
 * Keep them in step with what the connectors request (scopes, redirect URLs) in packages/integrations.
 */

export interface GuidePhase {
  /** Short label for the stepper. */
  label: string;
  title: string;
  steps: ReactNode[];
  /** Things worth knowing that are not steps (limits, gotchas). */
  notes?: ReactNode[];
}

export interface SetupGuide {
  /** Creating the developer app (OAuth) or the Application Password (WordPress). */
  create: GuidePhase;
  /** Field labels in the credentials form, in the platform's own words. */
  idLabel?: string;
  secretLabel?: string;
  /** Account preparation on the platform itself, before connecting (optional). */
  prepare?: GuidePhase;
  /** What to do in the platform's login window. */
  connect: GuidePhase;
}

const link = (href: string, text: string) => (
  <Anchor href={href} target="_blank" rel="noreferrer" inherit>
    {text}
  </Anchor>
);

const REDIRECT = 'the Redirect URL shown below';

export const SETUP_GUIDES: Record<Provider['id'], SetupGuide> = {
  meta: {
    idLabel: 'App ID',
    secretLabel: 'App secret',
    create: {
      label: 'Create app',
      title: 'Create a Meta developer app',
      steps: [
        <>
          Open {link('https://developers.facebook.com/apps', 'Meta for Developers → My Apps')} and
          click <b>Create app</b>. Use the Facebook account that manages your Pages.
        </>,
        <>
          When asked for use cases, pick <b>Manage everything on your Page</b>. If asked for an app
          type, choose <b>Business</b>. Connecting a business portfolio is optional.
        </>,
        <>
          Go to <b>Use cases → Manage everything on your Page → Customize</b> and click <b>Add</b>{' '}
          next to <code>pages_show_list</code>, <code>pages_manage_posts</code>,{' '}
          <code>pages_read_engagement</code> and <code>business_management</code>.
        </>,
        <>
          For Instagram, add the use case <b>Manage messaging &amp; content on Instagram</b>, open{' '}
          <b>Customize</b>, choose <b>API setup with Facebook login</b> (not “Instagram login”) and
          add <code>instagram_basic</code> and <code>instagram_content_publish</code>.
        </>,
        <>
          Open <b>Facebook Login → Settings</b> and paste {REDIRECT} into{' '}
          <b>Valid OAuth Redirect URIs</b>. Save.
        </>,
        <>
          Open <b>App settings → Basic</b>, then copy the <b>App ID</b> and the <b>App secret</b>{' '}
          (click Show).
        </>,
      ],
      notes: [
        <>
          Leave the app in <b>Development</b> mode. As the app’s admin you can use every permission
          without App Review.
        </>,
        <>
          “Invalid Scopes” on the Facebook login screen means one of the permissions above was not
          added to the app.
        </>,
      ],
    },
    prepare: {
      label: 'Instagram',
      title: 'Get Instagram ready (skip if you only use Facebook)',
      steps: [
        <>
          In the Instagram app, go to <b>Settings → Account type and tools</b> and{' '}
          <b>Switch to professional account</b> (Business or Creator). Personal accounts cannot be
          published to.
        </>,
        <>
          On Facebook, switch into your Page, then open{' '}
          <b>Settings → Linked accounts → Instagram → Connect account</b> and log in to Instagram.
          (Meta Business Suite → Settings → Instagram accounts works too.)
        </>,
        <>
          Repeat for each Page that has an Instagram account. PostHub finds Instagram through its
          Page.
        </>,
      ],
      notes: [
        <>
          Instagram downloads media from a public web address. Set up a media host on the Settings
          page (an S3-compatible bucket such as Cloudflare R2) before posting to Instagram.
        </>,
      ],
    },
    connect: {
      label: 'Connect',
      title: 'Connect your Pages and Instagram accounts',
      steps: [
        <>
          Click <b>Connect Facebook &amp; Instagram</b> below and log in to Facebook.
        </>,
        <>
          When Facebook asks what PostHub can access, choose <b>Edit settings</b> (or “Opt in to all
          current and future”) and tick <b>every Page and every Instagram account</b> you want to
          post to.
        </>,
        <>Leave all permissions switched on and click Save / Continue.</>,
        <>
          You come back here with each Page and its Instagram account listed. Added a Page later?
          Connect again: existing accounts are updated, not duplicated.
        </>,
      ],
    },
  },

  google: {
    idLabel: 'Client ID',
    secretLabel: 'Client secret',
    create: {
      label: 'Create app',
      title: 'Create a Google Cloud OAuth client',
      steps: [
        <>
          Open the {link('https://console.cloud.google.com/projectcreate', 'Google Cloud Console')}{' '}
          and create a project (any name, e.g. “PostHub”).
        </>,
        <>
          Go to{' '}
          {link(
            'https://console.cloud.google.com/apis/library/youtube.googleapis.com',
            'APIs & Services → Library → YouTube Data API v3',
          )}{' '}
          and click <b>Enable</b>.
        </>,
        <>
          Open {link('https://console.cloud.google.com/auth/overview', 'Google Auth Platform')} and
          click <b>Get started</b>: enter an app name and your email, choose <b>External</b> as the
          audience, and finish.
        </>,
        <>
          Under <b>Audience</b>, click <b>Publish app</b> so it is “In production”. Apps left in
          Testing are signed out every 7 days. It stays unverified, which is fine for your own use.
        </>,
        <>
          Under <b>Clients</b>, click <b>Create client</b>, choose <b>Web application</b>, and add{' '}
          {REDIRECT} under <b>Authorized redirect URIs</b>. Click Create.
        </>,
        <>
          Copy the <b>Client ID</b> and <b>Client secret</b>.
        </>,
      ],
    },
    prepare: {
      label: 'YouTube',
      title: 'Get your YouTube channel ready',
      steps: [
        <>
          Make sure the Google account has a channel (
          {link('https://www.youtube.com/create_channel', 'create one')} if not).
        </>,
        <>
          To upload videos longer than 15 minutes, verify the channel at{' '}
          {link('https://www.youtube.com/verify', 'youtube.com/verify')}.
        </>,
      ],
      notes: [
        <>
          YouTube keeps videos uploaded by apps it has not audited <b>private</b>. To publish public
          videos, request an audit with the{' '}
          {link(
            'https://support.google.com/youtube/contact/yt_api_form',
            'YouTube API Services audit form',
          )}
          .
        </>,
        <>The default API quota allows only a handful of uploads per day.</>,
      ],
    },
    connect: {
      label: 'Connect',
      title: 'Connect your channel',
      steps: [
        <>
          Click <b>Connect YouTube</b> below and pick the Google account. If the channel belongs to
          a Brand Account, pick the channel when asked.
        </>,
        <>
          On “Google hasn’t verified this app”, click <b>Advanced → Go to (your app name)</b>. It is
          your own app.
        </>,
        <>Tick every YouTube permission checkbox and click Continue.</>,
      ],
    },
  },

  linkedin: {
    idLabel: 'Client ID',
    secretLabel: 'Primary Client Secret',
    create: {
      label: 'Create app',
      title: 'Create a LinkedIn developer app',
      steps: [
        <>
          Open{' '}
          {link('https://www.linkedin.com/developers/apps/new', 'LinkedIn Developers → Create app')}
          . LinkedIn requires a company Page for the app listing: pick yours or create one. Posts
          still go to your personal profile.
        </>,
        <>Upload a logo, accept the terms and click Create app.</>,
        <>
          On the <b>Products</b> tab, request <b>Sign In with LinkedIn using OpenID Connect</b> and{' '}
          <b>Share on LinkedIn</b>. Both are approved instantly.
        </>,
        <>
          On the <b>Auth</b> tab, add {REDIRECT} under <b>Authorized redirect URLs for your app</b>.
        </>,
        <>
          On the same tab, copy the <b>Client ID</b> and <b>Primary Client Secret</b>.
        </>,
      ],
    },
    connect: {
      label: 'Connect',
      title: 'Connect your profile',
      steps: [
        <>
          Click <b>Connect LinkedIn</b> below, sign in and click <b>Allow</b>.
        </>,
        <>Your personal profile appears in the account list. Company Page posting comes later.</>,
      ],
      notes: [
        <>
          LinkedIn sign-ins last about 60 days. If LinkedIn posts start failing with a sign-in
          error, click Connect again.
        </>,
      ],
    },
  },

  wordpress: {
    create: {
      label: 'Password',
      title: 'Create an Application Password',
      steps: [
        <>
          The site must use <b>https://</b> and run WordPress 5.6 or newer.
        </>,
        <>
          Sign in to WordPress admin with an <b>Editor</b> or <b>Administrator</b> account and open{' '}
          <b>Users → Profile</b>.
        </>,
        <>
          Scroll to <b>Application Passwords</b>, type “PostHub” as the name and click{' '}
          <b>Add New Application Password</b>.
        </>,
        <>Copy the password right away. WordPress shows it only once (the spaces are fine).</>,
      ],
      notes: [
        <>
          No Application Passwords section? A security plugin (Wordfence, Solid Security, …) may
          have turned it off, or the site is not on HTTPS.
        </>,
      ],
    },
    connect: {
      label: 'Connect',
      title: 'Connect the site',
      steps: [
        <>Enter the site address, your WordPress username and the Application Password.</>,
        <>Use the Application Password, not your normal login password.</>,
      ],
    },
  },
};
