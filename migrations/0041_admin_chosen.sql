-- Every administrator row counts as chosen. Rows added before the column existed defaulted to
-- false, and an anonymous page load used to delete them (security finding GRAF-02).
update app_admin set chosen = true where not chosen;
