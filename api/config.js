module.exports = function configHandler(request, response) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  response.setHeader("Cache-Control", "no-store");

  if (!supabaseUrl || !supabaseAnonKey) {
    response.status(200).json({ enabled: false });
    return;
  }

  response.status(200).json({
    enabled: true,
    supabaseUrl,
    supabaseAnonKey
  });
};
