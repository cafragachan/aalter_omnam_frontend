export interface Hotel {
  id: string
  name: string
  slug: string
  location: string
  description: string
  image: string
  active: boolean
  coordinates: { lat: number; lng: number }
}

export interface Room {
  id: string
  name: string
  occupancy: string
  price: number
  hotelId: string
  image: string
}

export interface Amenity {
  id: string
  name: string
  hotelId: string
  scene: string
  image: string
}

export const hotels: Hotel[] = [
  {
    id: "1",
    name: "EDITION | Lake Como",
    slug: "edition-lake-como",
    location: "Lake Como, Italy",
    description: "Luxury lakeside retreat with stunning mountain views",
    image: "/images/edition-como.jpg",
    active: true,
    coordinates: { lat: 45.9931, lng: 9.2658 },
  },
  {
    id: "2",
    name: "W | Rome",
    slug: "w-rome",
    location: "Rome, Italy",
    description: "Modern luxury in the heart of the eternal city",
    image: "/images/w-rome.jpg",
    active: false,
    coordinates: { lat: 41.9028, lng: 12.4964 },
  },
  {
    id: "3",
    name: "POST | Rotterdam",
    slug: "post-rotterdam",
    location: "Rotterdam, Netherlands",
    description: "Contemporary design meets Dutch hospitality",
    image: "/images/post-rotterdam.jpg",
    active: false,
    coordinates: { lat: 51.9225, lng: 4.47917 },
  },
]

export const rooms: Room[] = [
  {
    id: "r1",
    name: "King Room",
    occupancy: "x2",
    price: 249,
    hotelId: "1",
    image: "/images/room-standard.jpg",
  },
  {
    id: "r2",
    name: "Two-Bedroom Suite",
    occupancy: "x4",
    price: 399,
    hotelId: "1",
    image: "/images/room-suite-double.jpg",
  },
  {
    id: "r3",
    name: "Three-Bedroom Suite",
    occupancy: "x6",
    price: 599,
    hotelId: "1",
    image: "/images/room-suite-triple.jpg",
  },
]

export const amenities: Amenity[] = [
  {
    id: "a1",
    name: "Lobby",
    hotelId: "1",
    scene: "lobby",
    image: "/images/amenity-lobby.jpg",
  },
  {
    id: "a2",
    name: "Conference Room",
    hotelId: "1",
    scene: "conference",
    image: "/images/amenity-conference.jpg",
  },
]

export function getHotelBySlug(slug: string): Hotel | undefined {
  return hotels.find((h) => h.slug === slug)
}

export function getRoomsByHotelId(hotelId: string): Room[] {
  return rooms.filter((r) => r.hotelId === hotelId)
}

export function getAmenitiesByHotelId(hotelId: string): Amenity[] {
  return amenities.filter((a) => a.hotelId === hotelId)
}
