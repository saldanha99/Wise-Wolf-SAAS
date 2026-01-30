export const isBusinessDay = (date: Date): boolean => {
    const day = date.getDay();
    // 0 = Sunday, 6 = Saturday
    return day !== 0 && day !== 6;
};

export const getNthBusinessDay = (year: number, month: number, n: number): Date => {
    const date = new Date(year, month, 1);
    let businessDaysCount = 0;

    // Loop until we find the Nth business day
    while (businessDaysCount < n) {
        if (isBusinessDay(date)) {
            businessDaysCount++;
        }
        if (businessDaysCount < n) {
            date.setDate(date.getDate() + 1);
        }
    }
    return date;
};

export const getFinancialCutoffDate = (currentDate: Date = new Date()): Date => {
    // Returns the 10th business day of the CURRENT month
    return getNthBusinessDay(currentDate.getFullYear(), currentDate.getMonth(), 10);
};

export const shouldExpireLesson = (lessonRawDate: string): boolean => {
    const lessonDate = new Date(lessonRawDate);
    const now = new Date();

    // Safety check for invalid dates
    if (isNaN(lessonDate.getTime())) return false;

    // 1. If lesson is in the future or current month, it NEVER expires by Hard Limit
    // (We compare Year and Month)
    if (lessonDate.getFullYear() > now.getFullYear()) return false;
    if (lessonDate.getFullYear() === now.getFullYear() && lessonDate.getMonth() >= now.getMonth()) return false;

    // 2. Lesson is from a previous month. 
    // Check if we are PAST the 10th Business Day of the CURRENT month.
    const cutoffDate = getFinancialCutoffDate(now);

    // If Now is AFTER the cutoff date (e.g. Now is 15th, Cutoff was 12th) -> EXPIRE
    // We compare time values to be precise, or just dates. 
    // Let's assume Cutoff happens at 00:00 of that day? Or end of day? 
    // Usually "Until the 10th" means inclusive. So if today IS the 10th, it's open. 
    // If today is 11th, it's closed.

    // Reset hours for accurate date comparison
    const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const cutoffMidnight = new Date(cutoffDate.getFullYear(), cutoffDate.getMonth(), cutoffDate.getDate());

    return nowMidnight > cutoffMidnight;
};
