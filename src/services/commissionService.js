const PlatformCommissionService = {
  calculateCommission(amount) {
    const rate = parseFloat(process.env.PLATFORM_COMMISSION_RATE) || 0.15;
    return {
      total: amount,
      commission: amount * rate,
      providerEarning: amount * (1 - rate)
    };
  },

  async processRentalPayment(rental, listing) {
    const actualCost = rental.actualCost || rental.estimatedCost;
    const commission = this.calculateCommission(actualCost);
    
    return {
      success: true,
      breakdown: {
        total: commission.total,
        platformCommission: commission.commission,
        providerEarning: commission.providerEarning
      }
    };
  }
};

module.exports = { PlatformCommissionService };
