-- Migration: Expand domain pool
--
-- 14 existing domains meant back-to-back repeats were common with ~150
-- teams. Adds 14 new domains grounded in 2026 high-growth sectors,
-- avoiding overlap with existing entries (Mobility, Climate, EdTech
-- already present under those or adjacent names).

INSERT INTO public.domains (name) VALUES
  ('Vertical AI & AI-Native SaaS'),
  ('Renewable Energy & Green Tech'),
  ('Space & Advanced Manufacturing'),
  ('Cybersecurity'),
  ('Biotechnology & Genomics'),
  ('Preventive & Personalized Healthcare'),
  ('Agritech & Sustainable Food Systems'),
  ('Workforce Training & Future of Work'),
  ('Electric & Smart Transportation'),
  ('Web3 & Decentralized Infrastructure'),
  ('Robotics & Industrial Automation'),
  ('Creator Economy & Digital Media'),
  ('GovTech & Public Sector Innovation'),
  ('Circular Economy & Sustainable Materials')
ON CONFLICT (name) DO NOTHING;
