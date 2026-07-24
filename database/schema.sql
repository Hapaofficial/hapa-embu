-- Production PostgreSQL draft
CREATE TABLE users (
  id UUID PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer','driver','merchant','admin')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE rides (
  id UUID PRIMARY KEY,
  customer_id UUID REFERENCES users(id),
  driver_id UUID REFERENCES users(id),
  ride_type TEXT NOT NULL,
  pickup_text TEXT NOT NULL,
  destination_text TEXT NOT NULL,
  status TEXT NOT NULL,
  fare_estimate NUMERIC(12,2),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE orders (
  id UUID PRIMARY KEY,
  customer_id UUID REFERENCES users(id),
  merchant_id UUID REFERENCES users(id),
  total NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
