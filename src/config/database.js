const { getSupabaseClient } = require('./supabase');

const connectDB = async () => {
  const supabaseConfigured = Boolean(
    process.env.SUPABASE_URL &&
    (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_PUBLISHABLE_KEY)
  );

  if (!supabaseConfigured) {
    throw new Error('No database backend available. Set Supabase environment keys.');
  }

  try {
    const client = getSupabaseClient(true);
    console.log('Supabase client configured for API mode.');
    return { mode: 'supabase', connection: client };
  } catch (error) {
    console.error('Supabase configuration error:', error);
    throw error;
  }
};

module.exports = { connectDB };