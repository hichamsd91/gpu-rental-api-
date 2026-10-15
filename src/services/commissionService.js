const PlatformCommissionService = {
  calculateCommission(amount, isFree = false) {
    // Free rentals: 0% commission (100% to provider)
    // Paid rentals: 0% platform commission (free platform model)
    const rate = isFree ? 0 : 0;
    return {
      total: amount,
      commission: amount * rate,
      providerEarning: amount * (1 - rate)
    };
  },

  async processRentalPayment(rental, listing) {
    const actualCost = rental.actualCost || rental.estimatedCost;
    const isFree = rental.isFree === true;
    const commission = this.calculateCommission(actualCost, isFree);
    
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