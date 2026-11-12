-- Analyses now also hold each document's betweenness (bridges between groups). Step every stored
-- analysis one revision back so the background pass computes it again soon; the stored
-- communities and importance keep showing meanwhile (see src/server/graph/analysis.ts).

update graph_analysis set rev = rev - 1 where rev > 0;
