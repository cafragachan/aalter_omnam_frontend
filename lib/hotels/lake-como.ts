// =============================================================================
// EDITION | Lake Como — full hotel bundle (hotel + rooms + amenities)
//
// One self-contained file per hotel. To add a new property, copy this template,
// fill it in, and register the exports inside `lib/hotel-data.ts`.
// =============================================================================

import type { Amenity, Hotel, Room } from "../hotel-data"

// ─── Hotel ────────────────────────────────────────────────────────────────────

export const lakeComoHotel: Hotel = {
  id: "1",
  name: "EDITION | Lake Como",
  slug: "edition-lake-como",
  location: "Lake Como, Italy",
  description:
    "The Lake Como EDITION introduces a bold new vision of lakeside luxury, " +
    "reimagining a historic 19th-century palazzo with refined contemporary design. " +
    "Set along the western shore with sweeping Bellagio views, the hotel blends " +
    "Italian heritage with EDITION's signature sophistication and vibrant social energy.",
  tagline: "A dynamic lakeside retreat where Italian heritage meets contemporary luxury.",
  image: "/images/edition-como.jpg",
  active: true,
  coordinates: { lat: 45.9931, lng: 9.2658 },
  address: {
    street: "Via Regina, 41",
    city: "Cadenabbia",
    postalCode: "22011",
    region: "Como, Lombardy",
    country: "Italy",
    googleMapsUrl:
      "https://www.google.com/maps/place/Via+Regina,+41,+22011+Griante+CO,+Italy/@45.9919207,9.2349044,16z",
  },
  highlights: [
    "Sweeping views of Lake Como and the Bellagio promontory",
    "Culinary residency by Michelin-starred Chef Mauro Colagreco",
    "First Longevity Spa on Lake Como — science-based biohacking wellness",
    "Private dock and floating pool with direct waterfront access",
    "Interiors designed by internationally acclaimed firm Neri&Hu",
  ],
  tags: [
    "lakeside",
    "historic palazzo",
    "design-forward",
    "waterfront",
    "wellness",
    "fine dining",
    "romantic",
    "luxury",
  ],
  websiteUrl: "https://www.editionhotels.com/lake-como/",
}

// UE5's Cesium georeference origin for the Lake Como digital twin. POI markers
// spawned via AOSMInterestPointsManager are positioned relative to this point,
// so distances and Places-API location-bias queries must use it as the anchor.
// This is intentionally not the same as `lakeComoHotel.coordinates` (which is
// the marketing record for the hotel itself, ~1.2 km away).
export const LAKE_COMO_OSM_ANCHOR = { lat: 45.991825, lng: 9.238277 } as const

// ─── Rooms ────────────────────────────────────────────────────────────────────

export const lakeComoRooms: Room[] = [
  {
    id: "r1",
    name: "Standard Lake View",
    occupancy: "2",
    price: 249,
    hotelId: "1",
    image: "/images/room-standard.jpg",
    book_url: "https://www.editionhotels.com/lake-como/rooms-and-suites/standard-lake-view/",
    area: { min_sqm: 27, max_sqm: 34, label: "27-34 SQM" },
    roomType: "King bed",
    features: [
      "Air-conditioned rooms",
      "Nespresso machine",
      "Clothing steamer",
      "Iron & ironing board upon request",
      "Minibar",
      "In-room safe",
      "Rollaway Bed not permitted",
      "Baby cot available upon request",
    ],
    view: ["Lake view"],
    bedding: ["Down comforter pillows", "Custom imported linens"],
    bath: [
      "White marble bathroom with enclosed rain walk-in shower",
      "Single vanity",
      "Custom Le Labo amenities",
      "Hairdryer",
      "Robes & slippers",
    ],
    tech: [
      "Complimentary high-speed Wi-Fi",
      "55\" Flat screen SMART HDTV with streaming capabilities",
      "Bang & Olufsen Beoplay Bluetooth speaker",
    ],
    services: [
      "Twice-daily housekeeping service",
      "Complimentary bottled water daily",
      "Digital Press available",
    ],
  },
  {
    id: "r2",
    name: "Penthouse",
    occupancy: "6",
    price: 599,
    hotelId: "1",
    image: "/images/room-suite-double.jpg",
    book_url: "https://www.editionhotels.com/lake-como/rooms-and-suites/penthouse/",
    area: { min_sqm: 111, max_sqm: 111, label: "111 SQM" },
    roomType: "King bed",
    features: [
      "Air-conditioned rooms",
      "Private terrace",
      "Nespresso machine",
      "Clothing steamer",
      "Top floor",
      "Separate living area with sofa and lounge chairs",
      "Dining room and fully equipped kitchen",
      "Floor to ceiling windows",
      "Fridge",
      "Iron and ironing board upon request",
      "Minibar",
      "In-room safe",
      "Connecting rooms available",
      "Rollaway Bed available upon request at extra cost (up to 16 years old)",
    ],
    view: ["Lake view", "Mountain view"],
    bedding: ["Down comforter pillows", "Custom imported linens"],
    bath: [
      "White marble bathroom with enclosed rain walk-in shower",
      "Standalone bathtub",
      "Custom Le Labo amenities with exclusive signature EDITION scent",
      "Single vanity",
      "Make-up mirror",
      "Hairdryer",
      "Robes & slippers",
    ],
    tech: [
      "Complimentary high-speed Wi-Fi",
      "55\" Flat screen SMART HDTV with streaming capabilities",
      "Bang & Olufsen Beoplay Bluetooth speaker",
    ],
    services: [
      "Twice-daily housekeeping service",
      "Complimentary bottled water daily",
      "Digital Press available",
    ],
  },
  {
    id: "r3",
    name: "Loft Suite Lake View",
    occupancy: "4",
    price: 399,
    hotelId: "1",
    image: "/images/room-suite-triple.jpg",
    book_url: "https://www.editionhotels.com/lake-como/rooms-and-suites/loft-suite-lake-view-balcony/",
    area: { min_sqm: 41, max_sqm: 54, label: "41-54 SQM" },
    roomType: "King bed",
    features: [
      "Air-conditioned rooms",
      "Nespresso machine",
      "Clothing steamer",
      "Iron & ironing board upon request",
      "Minibar",
      "In-room safe",
      "Baby cot available upon request",
      "Rollaway Bed available upon request at extra cost (up to 16 years old)",
    ],
    view: ["Lake view"],
    bedding: ["Down comforter pillows", "Custom imported linens"],
    bath: [
      "White marble bathroom with enclosed rain walk-in shower",
      "Bathtub",
      "Single vanity",
      "Custom Le Labo amenities with exclusive signature EDITION scent",
      "Hairdryer",
      "Robes & slippers",
    ],
    tech: [
      "Complimentary high-speed Wi-Fi",
      "55\" Flat screen SMART HDTV with streaming capabilities",
      "Bang & Olufsen Beoplay Bluetooth speaker",
    ],
    services: [
      "Twice-daily housekeeping service",
      "Complimentary bottled water daily",
      "Digital Press available",
    ],
  },
  {
    id: "r4",
    name: "Standard Mountain View",
    occupancy: "2",
    price: 199,
    hotelId: "1",
    image: "/images/standard_mountain_view.jpg",
    book_url: "https://www.editionhotels.com/lake-como/rooms-and-suites/standard/",
    area: { min_sqm: 25, max_sqm: 32, label: "25-32 SQM" },
    roomType: "King bed",
    features: [
      "Air-conditioned rooms",
      "Nespresso machine",
      "Clothing steamer",
      "Iron & ironing board upon request",
      "Minibar",
      "In-room safe",
      "Rollaway Bed not permitted",
    ],
    view: ["Mountain view"],
    bedding: ["Down comforter pillows", "Custom imported linens"],
    bath: [
      "White marble bathroom with enclosed rain walk-in shower",
      "Single vanity",
      "Custom Le Labo amenities",
      "Hairdryer",
      "Robes & slippers",
    ],
    tech: [
      "Complimentary high-speed Wi-Fi",
      "55\" Flat screen SMART HDTV with streaming capabilities",
      "Bang & Olufsen Beoplay Bluetooth speaker",
    ],
    services: [
      "Twice-daily housekeeping service",
      "Complimentary bottled water daily",
      "Digital Press available",
    ],
  },
  {
    id: "r5",
    name: "Loft Suite Mountain View",
    occupancy: "4",
    price: 349,
    hotelId: "1",
    image: "/images/loft_mountain_view.jpg",
    book_url: "https://www.editionhotels.com/lake-como/rooms-and-suites/loft-suite-mountain-view/",
    area: { min_sqm: 49, max_sqm: 51, label: "49-51 SQM" },
    roomType: "King bed",
    features: [
      "Air-conditioned rooms",
      "Nespresso machine",
      "Clothing steamer",
      "Iron & ironing board upon request",
      "Minibar",
      "In-room safe",
      "Baby cot available upon request",
      "Rollaway Bed available upon request at extra cost (up to 16 years old)",
    ],
    view: ["Mountain view"],
    bedding: ["Down comforter pillows", "Custom imported linens"],
    bath: [
      "White marble bathroom with enclosed rain walk-in shower",
      "Bathtub",
      "Single vanity",
      "Custom Le Labo amenities with exclusive signature EDITION scent",
      "Hairdryer",
      "Robes & slippers",
    ],
    tech: [
      "Complimentary high-speed Wi-Fi",
      "55\" Flat screen SMART HDTV with streaming capabilities",
      "Bang & Olufsen Beoplay Bluetooth speaker",
    ],
    services: [
      "Twice-daily housekeeping service",
      "Complimentary bottled water daily",
      "Digital Press available",
    ],
  },
]

// ─── Amenities ────────────────────────────────────────────────────────────────
//
// `active: false` entries are staged data — fully described, but not yet wired
// up to a UE5 scene. They're filtered out by `getAmenitiesByHotelId` so the
// AmenitiesPanel and journey machine don't see them. Flip to `active: true`
// (or remove the flag) once the corresponding UE5 scene exists.

export const lakeComoAmenities: Amenity[] = [
  {
    id: "a1",
    name: "Lobby",
    hotelId: "1",
    scene: "lobby",
    image: "/images/amenity-lobby.jpg",
    category: "bar",
    description:
      "Aperitivo unfolds beneath five-meter vaulted ceilings and celadon marble " +
      "elegance. With live piano, curated cocktails, and Italian bites served against " +
      "a backdrop of rose plaster, antique mirrors, and modern art, the Lobby Bar " +
      "channels the spirit of a contemporary Italian salon.",
    shortDescription:
      "An all-day Italian salon with live piano, curated cocktails, and aperitivo " +
      "beneath five-meter vaulted ceilings.",
    hours: [
      { label: "Breakfast", open: "07:00", close: "11:00", days: "Daily" },
      { label: "All-day food", open: "11:00", close: "23:00", days: "Daily" },
      { label: "Bar", open: "07:00", close: "01:00", days: "Daily" },
    ],
    features: [
      "Five-meter vaulted ceilings",
      "Celadon marble interiors",
      "Rose plaster walls and antique mirrors",
      "Modern art collection",
      "Live piano",
      "Full breakfast service",
      "All-day food menu",
    ],
    highlights: [
      "The social heart of the hotel — ideal for aperitivo and evening cocktails",
      "Live piano creates an ambient, salon-like atmosphere",
      "Serves from breakfast through to late-night bar",
    ],
    tags: ["cocktails", "aperitivo", "live music", "breakfast", "all-day dining", "Italian"],
    menuUrl:
      "https://www.editionhotels.com/wp-content/uploads/2026/04/EDITION_LakeComo_LobbyBar_Menu_8-sett.pdf.pdf",
  },
  {
    id: "a2",
    name: "Conference Room",
    hotelId: "1",
    scene: "conference",
    image: "/images/amenity-conference.jpg",
    category: "meetings",
    description:
      "Two meeting rooms — one with natural light — supported by a pre-function " +
      "area adjacent to the main room. Executive car service and pre-arrival " +
      "itinerary customization are available to complement business stays.",
    shortDescription:
      "Intimate meeting facilities with natural light, supported by pre-function " +
      "space and full executive concierge services.",
    features: [
      "2 meeting rooms (1 with natural light)",
      "Pre-function area adjacent to meeting room",
      "Complimentary high-speed Wi-Fi",
      "Pre-arrival concierge for itinerary customization",
      "Executive car service available",
    ],
    highlights: [
      "Boutique-scale meeting space — ideal for intimate board sessions",
      "Natural-light room available for all-day meetings",
      "Full executive concierge support before and during the stay",
    ],
    tags: ["meetings", "business", "events", "executive", "private"],
  },
  {
    id: "a3",
    name: "Pool",
    hotelId: "1",
    scene: "pool",
    image: "/images/amenity-conference.jpg",
    category: "pool",
    description:
      "A relaxed yet elevated take on poolside dining, where refined comfort meets " +
      "bold simplicity. The menu is Mediterranean at heart, with playful global touches " +
      "and a focus on fast, flavourful execution. As the sun dips, the vibe shifts " +
      "effortlessly into aperitivo mode with spritzes, salty bites, and lakeside lounging.",
    shortDescription:
      "Floating lakeside pool with elevated Mediterranean poolside dining and a " +
      "laid-back aperitivo atmosphere as the evening rolls in.",
    hours: [
      { label: "Pool & Dining", open: "09:00", close: "18:00", days: "Daily" },
    ],
    features: [
      "Floating pool with direct lake access",
      "Mediterranean-inspired menu",
      "Locally sourced, high-quality ingredients",
      "Dishes designed for sharing",
      "Aperitivo service at sunset",
      "Signature dishes: crispy octopus tacos, fish burgers, tramezzini",
    ],
    highlights: [
      "The only floating pool on Lake Como — a signature experience",
      "Casual but elevated — great for a full poolside day",
      "Seamlessly transitions from daytime dining to sunset aperitivo",
    ],
    tags: [
      "pool",
      "waterfront",
      "Mediterranean",
      "aperitivo",
      "casual dining",
      "summer",
      "floating pool",
    ],
    menuUrl:
      "https://www.editionhotels.com/wp-content/uploads/2026/04/EDITION_LakeComo_The-Pool_Menu-V2-24.04.26.pdf-.pdf",
  },

  // ─── Staged amenities ──────────────────────────────────────────────────────
  // Below entries are real Lake Como amenities, but their UE5 scenes don't
  // exist yet. They're kept inactive so they don't surface in the AmenitiesPanel
  // (where a tap would send a `communal` message UE5 can't handle). Activate
  // by setting `active: true` once the scene ships.

  {
    id: "a4",
    name: "Cetino by Mauro Colagreco",
    hotelId: "1",
    scene: "cetino",
    image: "/images/amenity-cetino.jpg",
    active: false,
    category: "dining",
    description:
      "Cetino is Mauro Colagreco's first restaurant in Italy — a landmark opening " +
      "that redefines expectations on Lake Como. Rooted in the region's natural terroir " +
      "and shaped by Colagreco's role as UNESCO Ambassador for Biodiversity, Cetino " +
      "brings circular gastronomy to life with hyper-seasonal ingredients, local " +
      "producers, and a deep respect for nature's rhythm.",
    shortDescription:
      "The first Italian restaurant by Michelin-starred Chef Mauro Colagreco, " +
      "celebrating circular gastronomy and Lake Como's natural terroir.",
    hours: [{ label: "Dinner", open: "18:00", close: "21:30", days: "Daily" }],
    features: [
      "Hyper-seasonal tasting menu",
      "Ingredients sourced from local producers",
      "Circular gastronomy philosophy",
      "Convivial, emotion-led dining experience",
      "Cocktail program alongside fine dining",
    ],
    highlights: [
      "Mauro Colagreco's debut Italian restaurant — a landmark Lake Como opening",
      "UNESCO Biodiversity Ambassador ethos woven into every dish",
      "Where world-class cuisine meets genuine conviviality",
    ],
    tags: [
      "fine dining",
      "Michelin-starred chef",
      "seasonal",
      "biodiversity",
      "tasting menu",
      "Italian",
    ],
    externalUrl: "https://www.cetinorestaurantlakecomo.com/",
  },
  {
    id: "a5",
    name: "Renzo",
    hotelId: "1",
    scene: "renzo",
    image: "/images/amenity-renzo.jpg",
    active: false,
    category: "dining",
    description:
      "An all-day dining destination inspired by the warmth of Italian family " +
      "gatherings. RENZO offers a relaxed yet refined atmosphere where generous, " +
      "seasonal dishes are designed for sharing. The space opens onto a pergola-shaded " +
      "terrace framed by Mediterranean herbs, citrus trees, and lake views.",
    shortDescription:
      "All-day Italian dining on a pergola-shaded terrace — from nourishing breakfasts " +
      "to slow aperitivos, inspired by the spirit of family gathering.",
    hours: [
      { label: "Breakfast", open: "07:00", close: "11:00", days: "Daily" },
      { label: "Lunch", open: "12:30", close: "16:00", days: "Daily" },
      { label: "Dinner", open: "18:30", close: "22:30", days: "Daily" },
    ],
    features: [
      "Pergola-shaded outdoor terrace",
      "Mediterranean herbs and citrus garden",
      "Panoramic lake views from terrace",
      "Dishes designed for sharing",
      "Leisurely brunch and slow aperitivo service",
    ],
    highlights: [
      "The most relaxed dining on property — great for families and long lunches",
      "Terrace framed by herbs and citrus trees with lake views",
      "Open morning to night, moving with the rhythm of the day",
    ],
    tags: [
      "all-day dining",
      "Italian",
      "terrace",
      "family-friendly",
      "brunch",
      "aperitivo",
      "sharing plates",
    ],
    externalUrl: "https://www.renzorestaurantlakecomo.com/",
  },
  {
    id: "a6",
    name: "The Longevity Spa",
    hotelId: "1",
    scene: "spa",
    image: "/images/amenity-spa.jpg",
    active: false,
    category: "spa",
    description:
      "The first science-based longevity spa on Lake Como, offering a diagnostic-led " +
      "approach to wellness rooted in holistic therapies and biohacking. Guests begin " +
      "with an expert-led assessment — measuring sleep quality, inflammation, oxidative " +
      "stress, and more — to build a personalized longevity journey.",
    shortDescription:
      "Lake Como's first longevity spa — diagnostics, biohacking, and immersive " +
      "therapies with floor-to-ceiling lake views.",
    hours: [
      { label: "Spa Facilities", open: "09:00", close: "20:00", days: "Daily" },
      { label: "Treatments", open: "10:00", close: "19:00", days: "Daily" },
    ],
    features: [
      "10 treatment rooms",
      "Indoor vitality pool with floor-to-ceiling lake views",
      "Turkish bath (hammam)",
      "Herbal sauna",
      "Plunge pools",
      "Outdoor relaxation terraces with Mediterranean flora",
      "Expert-led diagnostic assessment on arrival",
      "Personalized longevity journey planning",
      "Le Labo signature product treatments",
    ],
    highlights: [
      "First longevity spa of its kind on Lake Como",
      "Science-backed diagnostics — sleep, inflammation, oxidative stress",
      "Indoor vitality pool with panoramic lake views",
    ],
    tags: [
      "wellness",
      "biohacking",
      "longevity",
      "spa",
      "diagnostics",
      "holistic",
      "hammam",
      "sauna",
      "plunge pool",
    ],
    externalUrl: "https://www.longevityspathelakecomoedition.com/",
    menuUrl:
      "https://www.editionhotels.com/wp-content/uploads/2026/01/EDITION_LakeComo_Spa_Menu_New_Guests.pdf",
  },
  {
    id: "a7",
    name: "Gym",
    hotelId: "1",
    scene: "gym",
    image: "/images/amenity-gym.jpg",
    active: false,
    category: "fitness",
    description:
      "An expansive 150 sqm fitness studio designed to reflect the energy of the " +
      "lake and mountains. Outfitted with state-of-the-art Technogym equipment, " +
      "the space supports strength training, cardio, and functional fitness. " +
      "The light-filled interior features natural oak floors and mirrored walls.",
    shortDescription:
      "150 sqm Technogym-equipped fitness studio with natural oak floors, " +
      "open 24 hours with personal training and wellness classes on request.",
    hours: [
      { label: "Gym", open: "00:00", close: "23:59", days: "Daily", is24Hours: true },
    ],
    features: [
      "150 sqm fitness floor",
      "State-of-the-art Technogym equipment",
      "Free weights and stretching area",
      "Natural oak floors and mirrored walls",
      "Complimentary towels",
      "Headphones and refreshments provided",
      "Personal trainer sessions available on request",
      "Yoga and Pilates classes on request",
      "Seasonal wellness program",
    ],
    highlights: [
      "Open 24 hours — train on your own schedule",
      "Technogym equipment across strength, cardio, and functional zones",
      "Personal training, Yoga, and Pilates available on request",
    ],
    tags: [
      "fitness",
      "gym",
      "24-hour",
      "Technogym",
      "personal training",
      "yoga",
      "pilates",
      "wellness",
    ],
  },
  {
    id: "a8",
    name: "Private Dock & Waterfront",
    hotelId: "1",
    scene: "waterfront",
    image: "/images/amenity-waterfront.jpg",
    active: false,
    category: "waterfront",
    description:
      "A private dock and direct waterfront access provide a seamless connection " +
      "to Lake Como. Guests can arrive and depart by water, embark on scenic boat " +
      "tours, and enjoy curated lake experiences arranged by the concierge team.",
    shortDescription:
      "Private dock on Lake Como with direct water access, boat tours, " +
      "and curated lake experiences.",
    features: [
      "Private dock with direct lake access",
      "Water arrival and departure by boat",
      "Scenic boat tours arranged on request",
      "Curated lake excursions via concierge",
    ],
    highlights: [
      "Arrive directly by boat — the quintessential Lake Como entrance",
      "Concierge-curated boat tours to Bellagio, Varenna, and beyond",
      "Private dock exclusive to hotel guests",
    ],
    tags: ["waterfront", "boat", "lake", "excursions", "dock", "experiences"],
  },
]
