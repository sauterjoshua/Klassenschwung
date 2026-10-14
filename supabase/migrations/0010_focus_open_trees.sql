-- =====================================================================
-- Klassenschwung – Fokus-Wald: Baeume aus dem offenen Ziel
-- =====================================================================
-- Setzt 0003_focus.sql voraus.
--
-- Im offenen Ziel waechst ein Kirschbaum, in dem nach und nach Voegel
-- einziehen. Damit der Wald ihn so zeigt (und nicht als die Art, die zur
-- Zeit eines festen Ziels gehoert), merkt sich der Baum, dass er aus dem
-- offenen Ziel stammt. Ohne diese Migration speichert die App offene
-- Baeume wie bisher, nur ohne Voegel im Wald.
-- =====================================================================

alter table public.focus_trees
  add column if not exists open_goal boolean not null default false;

notify pgrst, 'reload schema';
