# Metaverse Hotel Booking System

A Next.js application for booking virtual hotel experiences with glassmorphism UI and pixel-stream integration.

## Features

- **Authentication**: Mock login system with email/password
- **Search**: Search hotels by destination, dates, and guest count
- **Hotel Browsing**: Browse and explore luxury metaverse hotels
- **Room Booking**: View room details, pricing, and make reservations
- **Pixel Streaming**: Integrated iframe container for virtual hotel tours
- **Glassmorphism UI**: Modern translucent design with backdrop blur effects

## Tech Stack

- Next.js 16 (App Router)
- TypeScript
- Tailwind CSS v4
- shadcn/ui components
- React Context for state management

## Getting Started

### Installation

1. Clone the repository
2. Install dependencies:

```bash
npm install
# or
yarn install
# or
pnpm install
```

### Environment Variables

Create a `.env.local` file in the root directory:

```env
# Optional: Pixel stream iframe URL
NEXT_PUBLIC_VAGON_IFRAME_URL=https://your-pixel-stream-url.com
```

If not set, the app will prompt users to enter a stream URL when accessing the virtual tour feature.

### Development

Run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) to view the app.

### Building for Production

```bash
npm run build
npm start
```

## Deployment

### Deploy to Vercel

1. Push your code to GitHub
2. Import your repository to Vercel
3. Add environment variables in Vercel dashboard:
   - `NEXT_PUBLIC_VAGON_IFRAME_URL` (optional)
4. Deploy

Or use the Vercel CLI:

```bash
vercel
```

## Project Structure

```
├── app/
│   ├── login/              # Login page
│   ├── loading/            # Loading screen
│   ├── search/             # Search interface
│   ├── destinations/       # Hotel listing
│   └── hotel/[slug]/       # Hotel details & virtual tours
├── components/
│   ├── ui/                 # shadcn/ui components
│   ├── glass-panel.tsx     # Glassmorphism container
│   ├── pixel-stream-frame.tsx  # Iframe pixel stream component
│   └── loading-overlay.tsx # Loading overlay
├── lib/
│   ├── mock-data.ts        # Hotel, room, and amenity data
│   ├── store.tsx           # React Context state management
│   └── utils.ts            # Utility functions
└── public/placeholders/    # Background SVG assets
```

## Routes

- `/` - Home (redirects to login or search)
- `/login` - Authentication
- `/loading` - Loading screen
- `/search` - Search interface
- `/destinations` - Browse hotels
- `/hotel/[slug]` - Hotel details with tabs (Location/Rooms/Amenities)
- `/hotel/[slug]/outside` - Hotel exterior view
- `/hotel/[slug]/inside` - Virtual tour with pixel streaming

## Features in Detail

### Glassmorphism Design

The app uses a custom `GlassPanel` component with:
- Translucent backgrounds (`bg-white/10`)
- Backdrop blur effects
- Soft borders and rounded corners
- Smooth hover transitions

### Pixel Streaming

The `PixelStreamFrame` component provides:
- Responsive iframe container
- Background placeholders while loading
- Control bar with quality, mute, reload, and fullscreen options
- Scene-based background switching (room, lobby, conference)
- URL configuration via dialog or environment variable

### State Management

Uses React Context for:
- Authentication state
- Search criteria
- Selected hotel
- Booking history
- Loading states

## Mock Data

The app includes mock data for:
- 3 luxury hotels (EDITION Lake Como, W Rome, POST Rotterdam)
- Room types with pricing
- Amenities (Lobby, Conference Room)

## License

MIT

## Credits

Built with v0 by Vercel
